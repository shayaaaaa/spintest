// Virtual file system over the Origin Private File System (OPFS). The VFS root is the Hub folder: "/" = Hub root.
// Works in windows and workers. Writes use createWritable() where available, otherwise a worker with sync access
// handles (older Safari), so it runs on every WebKit/Chromium that has OPFS.
import { Emitter, globToRegExp } from './util.js';

const ROOT_NAME = 'Hub';
const enc = new TextEncoder();
const dec = new TextDecoder();

export const events = new Emitter();
const bc = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('ai-agent-vfs') : null;
if (bc) bc.onmessage = (e) => events.emit('change', { ...e.data, remote: true });
function changed(path, type) {
  const ev = { path, type, t: Date.now() };
  events.emit('change', ev);
  try { bc?.postMessage(ev); } catch {}
}

// ---------- paths ----------
export function normalize(p, cwd = '/') {
  if (p == null) p = '';
  p = String(p).trim();
  if (p.startsWith('~/')) p = p.slice(1);
  else if (p === '~') p = '/';
  if (p.startsWith('/Hub/')) p = p.slice(4);
  else if (p === '/Hub') p = '/';
  if (!p.startsWith('/')) p = (cwd.endsWith('/') ? cwd : cwd + '/') + p;
  const parts = [];
  for (const seg of p.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') parts.pop(); else parts.push(seg);
  }
  return '/' + parts.join('/');
}
export const join = (...a) => normalize(a.join('/'));
export const dirname = (p) => { p = normalize(p); const i = p.lastIndexOf('/'); return i <= 0 ? '/' : p.slice(0, i); };
export const basename = (p) => { p = normalize(p); return p.slice(p.lastIndexOf('/') + 1); };
export function relative(from, to) {
  const a = normalize(from).split('/').filter(Boolean), b = normalize(to).split('/').filter(Boolean);
  let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return [...Array(a.length - i).fill('..'), ...b.slice(i)].join('/') || '.';
}
const segs = (p) => normalize(p).split('/').filter(Boolean);

// ---------- handles ----------
let rootPromise = null;
export function root() {
  if (!rootPromise) rootPromise = (async () => {
    if (!navigator.storage?.getDirectory) throw new Error('This browser has no Origin Private File System (OPFS). Use Safari 17+ or a recent Chromium.');
    const opfs = await navigator.storage.getDirectory();
    return opfs.getDirectoryHandle(ROOT_NAME, { create: true });
  })();
  return rootPromise;
}

export async function dirHandle(path, create = false) {
  let h = await root();
  for (const s of segs(path)) h = await h.getDirectoryHandle(s, { create });
  return h;
}

export async function fileHandle(path, create = false) {
  const parts = segs(path);
  if (!parts.length) throw new Error('Not a file: /');
  const name = parts.pop();
  const d = await dirHandle('/' + parts.join('/'), create);
  return d.getFileHandle(name, { create });
}

function notFound(path) { const e = new Error(`No such file or directory: ${path}`); e.code = 'ENOENT'; return e; }
async function wrap(path, fn) {
  try { return await fn(); }
  catch (e) {
    if (e?.name === 'NotFoundError' || e?.name === 'TypeMismatchError') throw notFound(path);
    throw e;
  }
}

// ---------- reading ----------
export const getFile = (path) => wrap(path, async () => (await fileHandle(path)).getFile());
export async function readText(path) { return dec.decode(await (await getFile(path)).arrayBuffer()); }
export async function readBytes(path) { return new Uint8Array(await (await getFile(path)).arrayBuffer()); }
export async function readJSON(path, fallback) {
  try { return JSON.parse(await readText(path)); }
  catch (e) { if (fallback !== undefined) return fallback; throw e; }
}

export async function exists(path) {
  path = normalize(path);
  if (path === '/') return true;
  const parent = dirname(path), name = basename(path);
  try {
    const d = await dirHandle(parent);
    try { await d.getFileHandle(name); return true; } catch {}
    try { await d.getDirectoryHandle(name); return true; } catch {}
    return false;
  } catch { return false; }
}

export async function stat(path) {
  path = normalize(path);
  if (path === '/') return { path, name: '', kind: 'directory' };
  const d = await wrap(path, () => dirHandle(dirname(path)));
  const name = basename(path);
  try { const f = await (await d.getFileHandle(name)).getFile(); return { path, name, kind: 'file', size: f.size, mtime: f.lastModified }; } catch {}
  try { await d.getDirectoryHandle(name); return { path, name, kind: 'directory' }; } catch {}
  throw notFound(path);
}

export async function isDir(path) { try { return (await stat(path)).kind === 'directory'; } catch { return false; } }

export async function list(path, { details = true } = {}) {
  path = normalize(path);
  const d = await wrap(path, () => dirHandle(path));
  const out = [];
  for await (const [name, h] of d.entries()) {
    const e = { name, path: join(path, name), kind: h.kind };
    if (details && h.kind === 'file') { try { const f = await h.getFile(); e.size = f.size; e.mtime = f.lastModified; } catch {} }
    out.push(e);
  }
  out.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name, undefined, { numeric: true }) : a.kind === 'directory' ? -1 : 1));
  return out;
}

export const DEFAULT_IGNORE = new Set(['node_modules', '.git', '__pycache__', '.venv', 'dist', '.next', '.cache']);

// Depth-first walk. yields {path, name, kind, size, mtime}
export async function* walk(path, { maxDepth = 64, ignore = DEFAULT_IGNORE, details = false, includeDirs = false } = {}) {
  path = normalize(path);
  let entries;
  try { entries = await list(path, { details }); } catch { return; }
  for (const e of entries) {
    if (ignore && ignore.has(e.name)) continue;
    if (e.kind === 'directory') {
      if (includeDirs) yield e;
      if (maxDepth > 0) yield* walk(e.path, { maxDepth: maxDepth - 1, ignore, details, includeDirs });
    } else yield e;
  }
}

export async function glob(pattern, cwd = '/', opts = {}) {
  const abs = pattern.startsWith('/') || pattern.startsWith('~');
  const base = abs ? '/' : normalize(cwd);
  const pat = abs ? normalize(pattern).slice(1) : pattern.replace(/^\.\//, '');
  // Start the walk at the longest literal prefix directory for speed.
  const litParts = [];
  for (const p of pat.split('/')) { if (/[*?{[]/.test(p)) break; litParts.push(p); }
  const literalAll = litParts.length === pat.split('/').length;
  if (literalAll) { const p = join(base, pat); return (await exists(p)) ? [p] : []; }
  const start = join(base, litParts.join('/'));
  const re = globToRegExp(pat);
  const out = [];
  for await (const e of walk(start, { details: true, ...opts })) {
    const rel = e.path.slice(base === '/' ? 1 : base.length + 1);
    if (re.test(rel)) out.push(e);
  }
  out.sort((a, b) => (b.mtime || 0) - (a.mtime || 0));
  return out.map(e => e.path);
}

// ---------- writing ----------
const hasCreateWritable = typeof FileSystemFileHandle !== 'undefined' && 'createWritable' in FileSystemFileHandle.prototype;
const inWorker = typeof WorkerGlobalScope !== 'undefined' && self instanceof WorkerGlobalScope;
const locks = new Map();
async function withLock(path, fn) {
  const prev = locks.get(path) || Promise.resolve();
  let release;
  const p = new Promise(r => (release = r));
  locks.set(path, prev.then(() => p));
  await prev;
  try { return await fn(); } finally { release(); if (locks.get(path) === p) locks.delete(path); }
}

function toBytes(data) {
  if (data == null) return new Uint8Array(0);
  if (typeof data === 'string') return enc.encode(data);
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  throw new Error('Unsupported data type');
}

// Fallback writer worker for browsers without createWritable (uses createSyncAccessHandle).
let writer = null, writerSeq = 0;
const writerWaits = new Map();
function writerCall(msg, transfer = []) {
  if (!writer) {
    writer = new Worker(new URL('../workers/opfs-writer.worker.js', import.meta.url), { type: 'module' });
    writer.onmessage = (e) => { const w = writerWaits.get(e.data.id); if (!w) return; writerWaits.delete(e.data.id); e.data.error ? w.reject(new Error(e.data.error)) : w.resolve(e.data.result); };
  }
  const id = ++writerSeq;
  return new Promise((resolve, reject) => { writerWaits.set(id, { resolve, reject }); writer.postMessage({ id, root: ROOT_NAME, ...msg }, transfer); });
}

async function syncWrite(path, bytes, { append = false, offset = null, truncate = true } = {}) {
  const h = await fileHandle(path, true);
  const ah = await h.createSyncAccessHandle();
  try {
    const at = append ? ah.getSize() : offset ?? 0;
    if (!append && offset == null && truncate) ah.truncate(0);
    ah.write(bytes, { at });
    ah.flush();
  } finally { ah.close(); }
}

export async function mkdir(path) { await dirHandle(path, true); changed(normalize(path), 'mkdir'); }

export async function write(path, data, { append = false, silent = false } = {}) {
  path = normalize(path);
  await withLock(path, async () => {
    await dirHandle(dirname(path), true);
    if (data instanceof Blob && !append) {
      if (hasCreateWritable) {
        const w = await (await fileHandle(path, true)).createWritable();
        await w.write(data); await w.close();
        return;
      }
      data = new Uint8Array(await data.arrayBuffer());
    }
    const bytes = data instanceof Blob ? new Uint8Array(await data.arrayBuffer()) : toBytes(data);
    if (hasCreateWritable) {
      const fh = await fileHandle(path, true);
      const w = await fh.createWritable({ keepExistingData: append });
      if (append) { const size = (await fh.getFile()).size; await w.seek(size); }
      await w.write(bytes); await w.close();
    } else if (inWorker) await syncWrite(path, bytes, { append });
    else { const copy = bytes.slice(); await writerCall({ op: 'write', path, data: copy.buffer, append }, [copy.buffer]); }
  });
  if (!silent) changed(path, 'write');
}
export const writeText = write;
export const writeJSON = (path, obj, opts) => write(path, JSON.stringify(obj, null, 2), opts);
export const append = (path, data) => write(path, data, { append: true });

// Streaming writer (downloads, checkpoints). Supports resuming at an offset.
export async function createWriteStream(path, { offset = 0 } = {}) {
  path = normalize(path);
  await dirHandle(dirname(path), true);
  const fh = await fileHandle(path, true);
  let pos = offset;
  if (hasCreateWritable) {
    const w = await fh.createWritable({ keepExistingData: offset > 0 });
    if (offset > 0) await w.seek(offset);
    return {
      async write(chunk) { await w.write(chunk); pos += chunk.byteLength; },
      async close() { await w.close(); changed(path, 'write'); },
      async abort() { try { await w.abort(); } catch {} },
      get position() { return pos; },
    };
  }
  if (inWorker) {
    const ah = await fh.createSyncAccessHandle();
    if (offset === 0) ah.truncate(0);
    return {
      async write(chunk) { ah.write(toBytes(chunk), { at: pos }); pos += chunk.byteLength; },
      async close() { ah.flush(); ah.close(); changed(path, 'write'); },
      async abort() { try { ah.close(); } catch {} },
      get position() { return pos; },
    };
  }
  const sid = await writerCall({ op: 'open', path, offset });
  return {
    async write(chunk) { const c = toBytes(chunk).slice(); await writerCall({ op: 'chunk', sid, data: c.buffer }, [c.buffer]); pos += c.byteLength; },
    async close() { await writerCall({ op: 'close', sid }); changed(path, 'write'); },
    async abort() { try { await writerCall({ op: 'close', sid }); } catch {} },
    get position() { return pos; },
  };
}

export async function rm(path, { recursive = true, silent = false } = {}) {
  path = normalize(path);
  if (path === '/') throw new Error('Refusing to remove the Hub root');
  const d = await wrap(path, () => dirHandle(dirname(path)));
  await wrap(path, () => d.removeEntry(basename(path), { recursive }));
  if (!silent) changed(path, 'rm');
}

export async function copy(src, dst) {
  src = normalize(src); dst = normalize(dst);
  const s = await stat(src);
  if (s.kind === 'file') {
    await dirHandle(dirname(dst), true);
    await write(dst, await getFile(src), { silent: true });
  } else {
    await mkdir(dst);
    for (const e of await list(src, { details: false })) await copy(e.path, join(dst, e.name));
  }
  changed(dst, 'write');
}

export async function move(src, dst) {
  src = normalize(src); dst = normalize(dst);
  if (src === dst) return;
  if (dst.startsWith(src + '/')) throw new Error('Cannot move a folder into itself');
  const s = await stat(src);
  if (s.kind === 'file') {
    try {
      const h = await fileHandle(src);
      if (typeof h.move === 'function') {
        const d = await dirHandle(dirname(dst), true);
        await h.move(d, basename(dst));
        changed(src, 'rm'); changed(dst, 'write');
        return;
      }
    } catch { /* fall back to copy + delete */ }
  }
  await copy(src, dst);
  await rm(src);
}

export async function usage() {
  try { const e = await navigator.storage.estimate(); return { used: e.usage || 0, quota: e.quota || 0 }; }
  catch { return { used: 0, quota: 0 }; }
}

export async function persist() {
  try { if (navigator.storage?.persisted && await navigator.storage.persisted()) return true; return await navigator.storage?.persist?.(); }
  catch { return false; }
}

// Recursively sums file sizes.
export async function du(path) {
  let total = 0, files = 0;
  for await (const e of walk(path, { details: true, ignore: null })) { total += e.size || 0; files++; }
  return { bytes: total, files };
}

export async function ensureFile(path, content) { if (!(await exists(path))) await write(path, content, { silent: true }); }
