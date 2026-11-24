// Hugging Face Hub API (browser CORS is supported by the Hub). Token is optional (needed for gated models).
import { getSecret } from '../core/settings.js';

const HF = 'https://huggingface.co';
const auth = () => { const t = getSecret('hf_token'); return t ? { Authorization: 'Bearer ' + t } : {}; };

async function get(path, params) {
  const url = new URL(HF + path);
  for (const [k, v] of Object.entries(params || {})) if (v != null && v !== '') (Array.isArray(v) ? v : [v]).forEach(x => url.searchParams.append(k, x));
  const r = await fetch(url, { headers: auth() });
  if (r.status === 401 || r.status === 403) throw new Error('This repository needs a Hugging Face token with access (gated model). Add it in Settings → Models & keys, and accept the license on huggingface.co.');
  if (!r.ok) throw new Error(`Hugging Face: ${r.status} ${r.statusText}`);
  return r.json();
}

export async function searchModels(query, { filter, library, sort = 'downloads', limit = 30, author } = {}) {
  const list = await get('/api/models', { search: query, filter, library, sort, direction: -1, limit, author, full: 'false', config: 'false' });
  return list.map(m => ({ id: m.id || m.modelId, downloads: m.downloads, likes: m.likes, tags: m.tags || [], pipeline: m.pipeline_tag, library: m.library_name, gated: m.gated, updated: m.lastModified }));
}

export async function searchDatasets(query, { limit = 30 } = {}) {
  const list = await get('/api/datasets', { search: query, sort: 'downloads', direction: -1, limit });
  return list.map(d => ({ id: d.id, downloads: d.downloads, likes: d.likes, tags: d.tags || [] }));
}

export async function modelInfo(repo) { return get(`/api/models/${repo}`); }

// Lists all files (recursive) with sizes.
export async function listFiles(repo, { revision = 'main', type = 'models' } = {}) {
  const out = [];
  const walk = async (path) => {
    const items = await get(`/api/${type}/${repo}/tree/${encodeURIComponent(revision)}${path ? '/' + path : ''}`, { recursive: 'true' });
    for (const it of items) {
      if (it.type === 'file') out.push({ path: it.path, size: it.lfs?.size ?? it.size ?? 0 });
    }
  };
  await walk('');
  return out;
}

export const fileUrl = (repo, path, { revision = 'main', type = 'models' } = {}) =>
  `${HF}/${type === 'datasets' ? 'datasets/' : ''}${repo}/resolve/${encodeURIComponent(revision)}/${path.split('/').map(encodeURIComponent).join('/')}`;

export const authHeaders = auth;

// ---- Uploads (offload jobs, sharing adapters/datasets) ----
export async function whoami() {
  const r = await fetch(HF + '/api/whoami-v2', { headers: auth() });
  if (!r.ok) throw new Error('Hugging Face token missing or invalid.');
  return r.json();
}

export async function createRepo(name, { type = 'model', private: priv = true } = {}) {
  const r = await fetch(HF + '/api/repos/create', { method: 'POST', headers: { ...auth(), 'Content-Type': 'application/json' }, body: JSON.stringify({ name: name.split('/').pop(), organization: name.includes('/') ? name.split('/')[0] : undefined, type, private: priv }) });
  if (!r.ok && r.status !== 409) throw new Error(`Couldn't create repo: ${r.status} ${await r.text()}`);
}

async function sha256(buf) {
  const h = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(h)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// Commits files (small files inline as base64, large ones through Git LFS) to a repo.
export async function uploadFiles(repo, files, { type = 'model', message = 'Upload from Ai Agent', onProgress } = {}) {
  const prefix = type === 'dataset' ? 'datasets/' : type === 'space' ? 'spaces/' : '';
  const ops = [];
  let done = 0;
  for (const f of files) {
    const buf = f.data instanceof Blob ? await f.data.arrayBuffer() : (typeof f.data === 'string' ? new TextEncoder().encode(f.data).buffer : f.data);
    if (buf.byteLength < 5 * 1024 * 1024) {
      let s = ''; const u8 = new Uint8Array(buf);
      for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
      ops.push({ key: 'file', value: { path: f.path, content: btoa(s), encoding: 'base64' } });
    } else {
      const oid = await sha256(buf);
      const batch = await fetch(`${HF}/${prefix}${repo}.git/info/lfs/objects/batch`, {
        method: 'POST', headers: { ...auth(), Accept: 'application/vnd.git-lfs+json', 'Content-Type': 'application/vnd.git-lfs+json' },
        body: JSON.stringify({ operation: 'upload', transfers: ['basic'], hash_algo: 'sha256', objects: [{ oid, size: buf.byteLength }] }),
      }).then(r => r.json());
      const obj = batch.objects?.[0];
      if (obj?.actions?.upload) {
        const up = obj.actions.upload;
        const r = await fetch(up.href, { method: 'PUT', headers: up.header || {}, body: buf });
        if (!r.ok) throw new Error(`LFS upload failed: ${r.status}`);
        if (obj.actions.verify) await fetch(obj.actions.verify.href, { method: 'POST', headers: { ...(obj.actions.verify.header || {}), 'Content-Type': 'application/vnd.git-lfs+json' }, body: JSON.stringify({ oid, size: buf.byteLength }) });
      }
      ops.push({ key: 'lfsFile', value: { path: f.path, algo: 'sha256', oid, size: buf.byteLength } });
    }
    onProgress?.(++done / files.length);
  }
  const body = [JSON.stringify({ key: 'header', value: { summary: message, description: '' } }), ...ops.map(o => JSON.stringify(o))].join('\n');
  const r = await fetch(`${HF}/api/${type}s/${repo}/commit/main`, { method: 'POST', headers: { ...auth(), 'Content-Type': 'application/x-ndjson' }, body });
  if (!r.ok) throw new Error(`Commit failed: ${r.status} ${await r.text()}`);
  return r.json();
}
