// Artifact cache for WebLLM that reads model files directly from the Hub in OPFS (no second copy in Cache Storage).
// URLs look like <app>/hub/models/llm/<id>/resolve/main/<file>; "resolve/main/" is added by WebLLM and stripped here.
async function hubFile(path) {
  let d = await (await navigator.storage.getDirectory()).getDirectoryHandle('Hub');
  const parts = path.split('/').filter(Boolean).map(decodeURIComponent);
  const name = parts.pop();
  for (const p of parts) d = await d.getDirectoryHandle(p);
  return (await d.getFileHandle(name)).getFile();
}

export function hubPathFromUrl(url) {
  const u = new URL(url, self.location.href);
  const i = u.pathname.indexOf('/hub/');
  if (i < 0) return null;
  return u.pathname.slice(i + 5).replace('/resolve/main/', '/');
}

export class HubArtifactCache {
  async fetchWithCache(url, storetype, signal) {
    const p = hubPathFromUrl(url);
    let body;
    if (p) {
      const f = await hubFile(p).catch(() => null);
      if (!f) throw new Error(`Model file missing from the Hub: ${p}. Re-download the model in Studio → Models.`);
      body = f;
    } else {
      const r = await fetch(url, { signal });
      if (!r.ok) throw new Error(`Cannot fetch ${url}: ${r.status}`);
      body = await r.blob();
    }
    if (!storetype) return new Response(body);
    const t = storetype.toLowerCase();
    if (t === 'json') return JSON.parse(await body.text());
    if (t === 'arraybuffer') return body.arrayBuffer();
    return new Response(body);
  }
  async addToCache() {}
  async hasAllKeys(keys) {
    for (const k of keys) { const p = hubPathFromUrl(k); if (!p || !(await hubFile(p).then(() => true, () => false))) return false; }
    return true;
  }
  async deleteInCache() {}
}
