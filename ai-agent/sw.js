// Ai Agent service worker.
// 1. Offline: precaches the app shell (asset-manifest.json "core"); engines ("engines") are cached on first use or when
//    the user taps "Make everything available offline".
// 2. Cross-origin isolation: adds COOP/COEP headers so SharedArrayBuffer works (multithreaded llama.cpp, ONNX, Python).
// 3. Hub files: serves ./hub/<path> straight from the Origin Private File System with Range support, so model engines
//    load weights from the Hub without a second copy in Cache Storage.
const VERSION = 'b3692a89224e';
const CORE = 'ai-agent-core-' + VERSION;
const ENGINES = 'ai-agent-engines-v1';
const SCOPE = new URL(self.registration.scope);
const BASE = SCOPE.pathname; // e.g. /spintest/ai-agent/

let manifest = null;
async function getManifest() {
  if (manifest) return manifest;
  try {
    const r = await fetch(BASE + 'asset-manifest.json', { cache: 'no-store' });
    manifest = await r.json();
  } catch {
    const c = await caches.open(CORE);
    const r = await c.match(BASE + 'asset-manifest.json');
    manifest = r ? await r.json() : { core: [], engines: [] };
  }
  return manifest;
}

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const m = await getManifest();
    const c = await caches.open(CORE);
    const urls = ['', 'index.html', 'asset-manifest.json', ...m.core].map(u => BASE + u);
    // Fetch in small batches; 'reload' skips the HTTP cache so updates are fresh.
    for (let i = 0; i < urls.length; i += 8) {
      await Promise.all(urls.slice(i, i + 8).map(async u => {
        try { const r = await fetch(new Request(u, { cache: 'reload' })); if (r.ok) await c.put(u, r); } catch {}
      }));
    }
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith('ai-agent-core-') && k !== CORE) await caches.delete(k);
    await self.clients.claim();
  })());
});

function isolate(resp) {
  if (!resp || resp.status === 0 || resp.type === 'opaque') return resp;
  const h = new Headers(resp.headers);
  h.set('Cross-Origin-Opener-Policy', 'same-origin');
  h.set('Cross-Origin-Embedder-Policy', 'require-corp');
  h.set('Cross-Origin-Resource-Policy', 'same-origin');
  return new Response(resp.body, { status: resp.status, statusText: resp.statusText, headers: h });
}

const mime = (name) => {
  const e = (name.split('.').pop() || '').toLowerCase();
  return ({ html: 'text/html', js: 'text/javascript', mjs: 'text/javascript', css: 'text/css', json: 'application/json', wasm: 'application/wasm',
    md: 'text/markdown; charset=utf-8', txt: 'text/plain; charset=utf-8', svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
    gif: 'image/gif', webp: 'image/webp', pdf: 'application/pdf', mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', mp4: 'video/mp4',
    webm: 'video/webm', mov: 'video/quicktime', csv: 'text/csv; charset=utf-8', py: 'text/plain; charset=utf-8', zip: 'application/zip' })[e] || 'application/octet-stream';
};

async function hubFile(path) {
  let d = await (await navigator.storage.getDirectory()).getDirectoryHandle('Hub');
  const parts = path.split('/').filter(Boolean).map(decodeURIComponent);
  const name = parts.pop();
  for (const p of parts) d = await d.getDirectoryHandle(p);
  return (await d.getFileHandle(name)).getFile();
}

// Fallback when OPFS isn't exposed to service workers: ask an open window to read the bytes.
async function hubFileViaClient(path, range) {
  const clients = await self.clients.matchAll({ type: 'window' });
  if (!clients.length) throw new Error('no client');
  return new Promise((resolve, reject) => {
    const ch = new MessageChannel();
    ch.port1.onmessage = (e) => e.data.error ? reject(new Error(e.data.error)) : resolve(e.data);
    clients[0].postMessage({ type: 'hub-read', path, range }, [ch.port2]);
    setTimeout(() => reject(new Error('timeout')), 60000);
  });
}

function parseRange(h, size) {
  const m = /bytes=(\d*)-(\d*)/.exec(h || '');
  if (!m) return null;
  let start = m[1] === '' ? size - Number(m[2]) : Number(m[1]);
  let end = m[1] === '' ? size - 1 : (m[2] === '' ? size - 1 : Number(m[2]));
  if (isNaN(start) || start < 0) start = 0;
  end = Math.min(end, size - 1);
  return start <= end ? [start, end] : null;
}

async function serveHub(req, rel) {
  const headers = { 'Content-Type': mime(rel), 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store', 'Cross-Origin-Resource-Policy': 'same-origin' };
  try {
    let file;
    try { file = await hubFile(rel); }
    catch (err) {
      if (err && (err.name === 'NotFoundError' || err.name === 'TypeMismatchError')) return new Response('Not found', { status: 404, headers });
      const r = await hubFileViaClient(rel, req.headers.get('Range'));
      headers['Content-Length'] = String(r.bytes.byteLength);
      if (r.contentRange) headers['Content-Range'] = r.contentRange;
      return new Response(r.bytes, { status: r.contentRange ? 206 : 200, headers });
    }
    const range = parseRange(req.headers.get('Range'), file.size);
    if (range) {
      const [s, e] = range;
      headers['Content-Range'] = `bytes ${s}-${e}/${file.size}`;
      headers['Content-Length'] = String(e - s + 1);
      return new Response(req.method === 'HEAD' ? null : file.slice(s, e + 1), { status: 206, headers });
    }
    headers['Content-Length'] = String(file.size);
    return new Response(req.method === 'HEAD' ? null : file, { status: 200, headers });
  } catch (err) {
    return new Response('Hub read failed: ' + (err?.message || err), { status: 500, headers });
  }
}

async function fromNetworkFirst(req, timeoutMs = 3000) {
  const c = await caches.open(CORE);
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const r = await fetch(req, { signal: ctrl.signal, cache: 'no-cache' });
    clearTimeout(t);
    if (r.ok && req.method === 'GET') c.put(req, r.clone());
    return r;
  } catch {
    const hit = (await c.match(req, { ignoreSearch: true })) || (await caches.match(req, { ignoreSearch: true }));
    if (hit) return hit;
    if (req.mode === 'navigate') { const idx = await c.match(BASE + 'index.html'); if (idx) return idx; }
    return new Response('Offline and not cached: ' + new URL(req.url).pathname, { status: 503 });
  }
}

async function fromCacheFirst(req) {
  const hit = await caches.match(req, { ignoreSearch: true });
  if (hit) return hit;
  const r = await fetch(req);
  if (r.ok && req.method === 'GET') (await caches.open(ENGINES)).put(req, r.clone());
  return r;
}

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin || !url.pathname.startsWith(BASE)) return;
  const rel = url.pathname.slice(BASE.length);
  if (rel.startsWith('hub/')) { e.respondWith(serveHub(e.request, rel.slice(4))); return; }
  if (e.request.method !== 'GET') return;
  const isVendor = rel.startsWith('vendor/');
  e.respondWith((isVendor ? fromCacheFirst(e.request) : fromNetworkFirst(e.request)).then(isolate));
});

self.addEventListener('message', (e) => {
  const { type } = e.data || {};
  if (type === 'skip-waiting') self.skipWaiting();
  if (type === 'cache-engines') e.waitUntil(cacheEngines(e.source));
  if (type === 'version') e.source?.postMessage({ type: 'version', version: VERSION });
});

async function cacheEngines(client) {
  const m = await getManifest();
  const c = await caches.open(ENGINES);
  let done = 0;
  const total = m.engines.length;
  for (const u of m.engines) {
    const url = BASE + u;
    try { if (!(await c.match(url))) { const r = await fetch(url, { cache: 'reload' }); if (r.ok) await c.put(url, r); } } catch {}
    done++;
    client?.postMessage({ type: 'cache-engines-progress', done, total });
  }
  client?.postMessage({ type: 'cache-engines-done', total });
}
