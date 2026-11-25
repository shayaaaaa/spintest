// Retrieval: knowledge collections (Hub/knowledge/<name>/docs → index) and memory files.
// Hybrid search = BM25 keyword scores + embedding cosine similarity (on-device embeddings when available).
import * as vfs from '../core/vfs.js';
import { extOf, isTextName, sha256Hex, parseFrontMatter } from '../core/util.js';
import { createStore } from '../core/store.js';

export const ragStore = createStore({ indexing: null }); // {collection, done, total, text}

const tokenize = (s) => String(s).toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(w => w.length > 1 && !STOP.has(w));
const STOP = new Set('the a an and or of to in on for is are was were be been it this that with as at by from not but if then so do does did have has had you your we our they their he she his her its i me my can will would should could about into over than too very just also more most such these those there here what which who whom when where why how all any each few other some no nor only own same both'.split(' '));

export function chunkText(text, { size = 900, overlap = 150 } = {}) {
  const paras = text.split(/\n{2,}/);
  const chunks = [];
  let cur = '';
  for (const p of paras) {
    if ((cur + '\n\n' + p).length > size && cur) { chunks.push(cur.trim()); cur = cur.slice(-overlap) + '\n\n' + p; }
    else cur = cur ? cur + '\n\n' + p : p;
    while (cur.length > size * 1.6) { chunks.push(cur.slice(0, size).trim()); cur = cur.slice(size - overlap); }
  }
  if (cur.trim()) chunks.push(cur.trim());
  return chunks;
}

async function extract(path) {
  const ext = extOf(path);
  if (['pdf', 'docx', 'xlsx', 'pptx'].includes(ext)) { const { readDocument } = await import('../agent/tools/docs.js'); return readDocument(path); }
  if (['html', 'htm'].includes(ext)) { const { htmlToText } = await import('../agent/tools/web.js'); return htmlToText(await vfs.readText(path), ''); }
  if (isTextName(path)) return vfs.readText(path);
  return '';
}

export async function listCollections() {
  const out = [];
  for (const e of await vfs.list('/knowledge').catch(() => [])) {
    if (e.kind !== 'directory') continue;
    const meta = await vfs.readJSON(`${e.path}/index/meta.json`, null);
    let docs = 0; for await (const _ of vfs.walk(`${e.path}/docs`)) docs++;
    out.push({ name: e.name, path: e.path, docs, chunks: meta?.chunks || 0, indexed: meta?.updated || 0, embedModel: meta?.embedModel || null });
  }
  return out;
}

// (Re)indexes a collection incrementally (unchanged files are reused).
export async function indexCollection(name, { useEmbeddings = true } = {}) {
  const dir = `/knowledge/${name}`;
  await vfs.mkdir(`${dir}/docs`);
  const old = await vfs.readJSON(`${dir}/index/chunks.json`, { chunks: [] });
  const oldByFile = new Map();
  for (const c of old.chunks) { if (!oldByFile.has(c.file)) oldByFile.set(c.file, []); oldByFile.get(c.file).push(c); }
  const files = [];
  for await (const e of vfs.walk(`${dir}/docs`, { details: true })) files.push(e);
  const chunks = [];
  let embedModel = null, embed = null;
  if (useEmbeddings) { try { const m = await import('../models/embeddings.js'); embed = m.embed; embedModel = m.embedModel(); } catch {} }
  let done = 0;
  for (const f of files) {
    ragStore.set({ indexing: { collection: name, done, total: files.length, text: f.name } });
    const sig = `${f.size}:${f.mtime}`;
    const prev = oldByFile.get(f.path);
    if (prev && prev[0]?.sig === sig && (!embed || prev[0]?.v)) { chunks.push(...prev); done++; continue; }
    let text = '';
    try { text = await extract(f.path); } catch (e) { console.warn('extract failed', f.path, e); }
    const parts = chunkText(text);
    let vecs = null;
    if (embed && parts.length) { try { vecs = await embed(parts.map(p => `${f.name}\n${p}`)); } catch (e) { console.warn('embedding failed', e); embed = null; embedModel = null; } }
    parts.forEach((t, i) => chunks.push({ file: f.path, i, sig, text: t, v: vecs ? Array.from(vecs[i], x => Math.round(x * 1e4) / 1e4) : null }));
    done++;
  }
  const meta = { updated: Date.now(), chunks: chunks.length, files: files.length, embedModel };
  await vfs.writeJSON(`${dir}/index/chunks.json`, { chunks });
  await vfs.writeJSON(`${dir}/index/meta.json`, meta);
  ragStore.set({ indexing: null });
  cache.delete(name);
  return meta;
}

const cache = new Map();
async function loadIndex(name) {
  if (cache.has(name)) return cache.get(name);
  const d = await vfs.readJSON(`/knowledge/${name}/index/chunks.json`, { chunks: [] });
  const idx = buildBM25(d.chunks);
  cache.set(name, idx);
  return idx;
}

function buildBM25(chunks) {
  const docs = chunks.map(c => { const toks = tokenize(c.text); const tf = new Map(); for (const t of toks) tf.set(t, (tf.get(t) || 0) + 1); return { c, tf, len: toks.length }; });
  const df = new Map();
  for (const d of docs) for (const t of d.tf.keys()) df.set(t, (df.get(t) || 0) + 1);
  const avg = docs.reduce((a, d) => a + d.len, 0) / (docs.length || 1);
  return { docs, df, avg, N: docs.length };
}

function bm25(idx, q) {
  const qt = tokenize(q);
  const k1 = 1.4, b = 0.75;
  return idx.docs.map(d => {
    let s = 0;
    for (const t of qt) {
      const f = d.tf.get(t); if (!f) continue;
      const idf = Math.log(1 + (idx.N - idx.df.get(t) + 0.5) / (idx.df.get(t) + 0.5));
      s += idf * (f * (k1 + 1)) / (f + k1 * (1 - b + b * d.len / (idx.avg || 1)));
    }
    return s;
  });
}

async function memoryChunks() {
  const out = [];
  const files = ['/memory/MEMORY.md'];
  for (const cat of ['facts', 'people', 'episodes']) for (const e of await vfs.list(`/memory/${cat}`).catch(() => [])) if (e.kind === 'file') files.push(e.path);
  for (const f of files) {
    const t = await vfs.readText(f).catch(() => '');
    const { body, data } = parseFrontMatter(t);
    chunkText((data.title ? data.title + '\n' : '') + body, { size: 700 }).forEach((x, i) => out.push({ file: f, i, text: x }));
  }
  return out;
}

export async function search(query, { collection, k = 6, includeMemory = true } = {}) {
  const cols = collection ? [collection] : (await listCollections()).map(c => c.name);
  let qv = null;
  try { const { embed } = await import('../models/embeddings.js'); if ([...cols].length) qv = (await embed([query]))[0]; } catch {}
  const { cosine } = await import('../models/embeddings.js');
  const hits = [];
  for (const name of cols) {
    const idx = await loadIndex(name);
    if (!idx.N) continue;
    const kw = bm25(idx, query);
    const maxKw = Math.max(...kw, 1e-9);
    idx.docs.forEach((d, i) => {
      const sem = qv && d.c.v ? cosine(qv, d.c.v) : null;
      const score = sem != null ? 0.65 * sem + 0.35 * (kw[i] / maxKw) : kw[i] / maxKw;
      if (score > 0.05) hits.push({ score, text: d.c.text, source: `${d.c.file}#${d.c.i + 1}`, collection: name });
    });
  }
  if (includeMemory) {
    const mem = await memoryChunks();
    const idx = buildBM25(mem);
    const kw = bm25(idx, query);
    const maxKw = Math.max(...kw, 1e-9);
    idx.docs.forEach((d, i) => { if (kw[i] > 0) hits.push({ score: 0.9 * kw[i] / maxKw, text: d.c.text, source: d.c.file, collection: 'memory' }); });
  }
  hits.sort((a, b) => b.score - a.score);
  const seen = new Set();
  return hits.filter(h => !seen.has(h.text) && seen.add(h.text)).slice(0, k);
}

export async function addToCollection(name, files) {
  const dir = `/knowledge/${name}/docs`;
  await vfs.mkdir(dir);
  for (const f of files) await vfs.write(`${dir}/${f.name}`, f);
}
