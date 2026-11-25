// Model registry: lists cloud + Hub models, installs downloads, loads one local LLM at a time, and routes chat calls.
import * as vfs from '../core/vfs.js';
import { createStore } from '../core/store.js';
import { settings, secrets, getSecret } from '../core/settings.js';
import { PROVIDERS } from './providers.js';
import { listFiles, fileUrl } from './hf.js';
import { enqueue } from './downloader.js';
import { slug } from './local/tjs.js';

export const KINDS = ['llm', 'vision', 'speech', 'tts', 'embeddings', 'adapters'];
export const modelsStore = createStore({ local: [], loaded: null, status: { state: 'idle' }, cloudModels: {} });

export async function refreshModels() {
  const local = [];
  const prev = modelsStore.get().local;
  for (const kind of KINDS) {
    let entries;
    try { entries = await vfs.list(`/models/${kind}`, { details: false }); }
    catch (e) { if (e.code !== 'ENOENT') local.push(...prev.filter(m => m.ref?.startsWith(`local:${kind}/`))); continue; }
    for (const e of entries) {
      if (e.kind !== 'directory') continue;
      const ref = `local:${kind}/${e.name}`;
      let man;
      // A transient read failure must not make a model disappear: keep what we knew about it.
      try { man = await vfs.readJSON(`${e.path}/manifest.json`); }
      catch (err) { man = err.code === 'ENOENT' || err instanceof SyntaxError ? null : prev.find(m => m.ref === ref) || null; }
      if (man) local.push({ ...man, kind: man.kind || kind, id: man.id || e.name, dir: e.path, ref });
    }
  }
  local.sort((a, b) => (b.added || 0) - (a.added || 0));
  modelsStore.set({ local });
  return local;
}
vfs.events.on('change', (e) => { if (e.path.startsWith('/models/') && /manifest\.json$|^\/models\/[^/]+\/[^/]+$/.test(e.path)) refreshSoon(); });
let rT; function refreshSoon() { clearTimeout(rT); rT = setTimeout(refreshModels, 400); }

export const isReady = (m) => m.status === 'ready';

// All selectable chat models (ready local LLMs + cloud models with keys).
export function chatModels() {
  const out = [];
  for (const m of modelsStore.get().local) if (m.kind === 'llm' && isReady(m)) out.push({ ref: m.ref, label: m.name || m.id, sub: engineLabel(m.engine) + (m.params ? ' · ' + m.params : ''), local: true, vision: !!m.gguf?.mmproj, engine: m.engine });
  const s = settings.get();
  for (const [pid, p] of Object.entries(PROVIDERS)) {
    if (!getSecret(p.secret) && !(p.custom && s.providers?.custom?.enabled)) continue;
    if (s.providers?.[pid]?.enabled === false) continue;
    const fetched = modelsStore.get().cloudModels[pid] || [];
    const list = (p.models.length ? p.models : []).concat(fetched.filter(f => !p.models.some(x => x.id === f.id)));
    const favs = s.providers?.[pid]?.models;
    for (const m of list) {
      if (favs?.length && !favs.includes(m.id) && !p.models.some(x => x.id === m.id)) continue;
      out.push({ ref: `cloud:${pid}/${m.id}`, label: m.label || m.id, sub: p.label, local: false, vision: m.vision ?? true, provider: pid });
    }
  }
  return out;
}

export const engineLabel = (e) => ({ gguf: 'llama.cpp', mlc: 'WebLLM', onnx: 'ONNX', forge: 'Forge' }[e] || e);

export function parseRef(ref) {
  if (!ref) return null;
  const [type, rest] = [ref.slice(0, ref.indexOf(':')), ref.slice(ref.indexOf(':') + 1)];
  if (type === 'cloud') { const i = rest.indexOf('/'); return { type, provider: rest.slice(0, i), model: rest.slice(i + 1) }; }
  if (type === 'local') { const [kind, ...id] = rest.split('/'); return { type, kind, id: id.join('/') }; }
  return null;
}

export function modelLabel(ref) {
  const p = parseRef(ref);
  if (!p) return 'No model';
  if (p.type === 'cloud') return PROVIDERS[p.provider]?.models.find(m => m.id === p.model)?.label || p.model;
  const m = modelsStore.get().local.find(x => x.ref === ref);
  return m?.name || p.id;
}

export function manifestFor(ref) { return modelsStore.get().local.find(x => x.ref === ref) || null; }

// Picks the model for a role (agent, chat, code, complete, subagent, title), with sensible fallbacks.
export function modelFor(role = 'agent') {
  const s = settings.get().models || {};
  const avail = chatModels();
  const want = s[role] || (role !== 'agent' ? s.agent : '') || '';
  if (want && avail.some(m => m.ref === want)) return want;
  if (role === 'complete' || role === 'title') {
    const small = avail.filter(m => m.local).sort((a, b) => (manifestFor(a.ref)?.bytes || 0) - (manifestFor(b.ref)?.bytes || 0))[0];
    if (small) return small.ref;
  }
  return avail.find(m => m.local)?.ref || avail[0]?.ref || '';
}

export function contextWindow(ref) {
  const p = parseRef(ref);
  if (!p) return 8192;
  if (p.type === 'cloud') return PROVIDERS[p.provider]?.models.find(m => m.id === p.model)?.context || 128000;
  return manifestFor(ref)?.context || 4096;
}

// ---------- engines ----------
let active = { ref: null, engine: null, loading: null };
function setStatus(st) { modelsStore.set({ status: st }); }

export async function unloadLocal() {
  const e = active.engine;
  active = { ref: null, engine: null, loading: null };
  modelsStore.set({ loaded: null, status: { state: 'idle' } });
  await e?.unload?.();
}

export async function getEngine(ref) {
  if (active.ref === ref && active.engine) return active.engine;
  if (active.ref === ref && active.loading) return active.loading;
  if (active.engine || active.loading) { const prev = active; active = { ref: null, engine: null, loading: null }; try { await (prev.engine || await prev.loading.catch(() => null))?.unload?.(); } catch {} }
  const m = manifestFor(ref);
  if (!m) throw new Error('Model not found in the Hub. Download it in Studio → Models.');
  if (!isReady(m)) throw new Error(`${m.name || m.id} hasn't finished downloading.`);
  const onProgress = (p) => setStatus({ state: 'loading', ref, text: p.text, progress: p.progress });
  setStatus({ state: 'loading', ref, text: 'Starting engine…', progress: 0 });
  const loading = (async () => {
    let engine;
    if (m.engine === 'gguf') { const { WllamaEngine } = await import('./local/wllama.js'); engine = new WllamaEngine(m); }
    else if (m.engine === 'mlc') { const { WebLLMEngine } = await import('./local/webllm.js'); engine = new WebLLMEngine(m); }
    else if (m.engine === 'onnx') { const { ONNXEngine } = await import('./local/tjs.js'); engine = new ONNXEngine(m); }
    else if (m.engine === 'forge') { const { ForgeChatEngine } = await import('../forge/client.js'); engine = new ForgeChatEngine(m); }
    else throw new Error('Unknown engine: ' + m.engine);
    await engine.load(onProgress);
    return engine;
  })();
  active = { ref, engine: null, loading };
  try {
    const engine = await loading;
    if (active.loading === loading) { active = { ref, engine, loading: null }; modelsStore.set({ loaded: ref }); setStatus({ state: 'ready', ref }); }
    return engine;
  } catch (e) {
    if (active.loading === loading) active = { ref: null, engine: null, loading: null };
    setStatus({ state: 'error', ref, text: String(e.message || e) });
    throw e;
  }
}

// Unified chat call. Returns {content, stopReason, usage, model}.
export async function chat(ref, opts) {
  const p = parseRef(ref);
  if (!p) throw new Error('No model selected. Download one in Studio → Models or add an API key in Settings.');
  const s = settings.get().agent || {};
  if (p.type === 'cloud') {
    const prov = PROVIDERS[p.provider];
    if (prov.kind === 'anthropic') { const { anthropicChat } = await import('./anthropic.js'); return anthropicChat({ ...opts, model: p.model, maxTokens: opts.maxTokens }); }
    const { openaiChat } = await import('./openai.js');
    return openaiChat(p.provider, { ...opts, model: p.model, maxTokens: opts.maxTokens || 16000 });
  }
  const engine = await getEngine(ref);
  const t0 = performance.now();
  const res = await engine.chat({ temperature: s.temperature ?? 0.6, ...opts, maxTokens: opts.maxTokens || s.maxTokens || 2048 });
  res.ms = performance.now() - t0;
  return res;
}

// Quick one-shot text completion helper (titles, summaries, commit messages…).
export async function complete(ref, prompt, { system = '', maxTokens = 512, signal } = {}) {
  const r = await chat(ref, { system, messages: [{ role: 'user', content: prompt }], maxTokens, signal, thinking: 'off' });
  return r.content.filter(b => b.type === 'text').map(b => b.text).join('').trim();
}

export async function fetchCloudModels(pid) {
  const p = PROVIDERS[pid];
  const list = p.kind === 'anthropic' ? await (await import('./anthropic.js')).anthropicModels() : await (await import('./openai.js')).openaiModels(pid);
  modelsStore.set(s => ({ ...s, cloudModels: { ...s.cloudModels, [pid]: list } }));
  return list;
}

// ---------- installers ----------
export async function installGGUF({ name, repo, file, mmproj, params, context, tags, blurb, revision = 'main' }) {
  const files = await listFiles(repo, { revision });
  const want = [file, ...(mmproj ? [mmproj] : [])];
  // Split GGUFs: model-00001-of-00003.gguf etc.
  const m = /-(\d{5})-of-(\d{5})\.gguf$/.exec(file);
  if (m) { const stem = file.slice(0, m.index); for (const f of files) if (f.path.startsWith(stem) && /-\d{5}-of-\d{5}\.gguf$/.test(f.path) && !want.includes(f.path)) want.push(f.path); }
  const picked = want.map(p => { const f = files.find(x => x.path === p); if (!f) throw new Error(`${p} not found in ${repo}`); return f; });
  const id = slug(file.replace(/\.gguf$/i, '').replace(/-\d{5}-of-\d{5}$/, ''));
  const kind = mmproj ? 'llm' : 'llm';
  const dir = `/models/${kind}/${id}`;
  const local = (p) => p.split('/').pop();
  const manifest = { id, name: name || id, kind, engine: 'gguf', source: { repo, revision }, params, context: context || 8192, tags, blurb,
    gguf: { files: picked.filter(f => f.path !== mmproj).map(f => local(f.path)).sort(), mmproj: mmproj ? 'mmproj-' + local(mmproj).replace(/^mmproj-/, '') : null }, added: Date.now() };
  return enqueue({ name: manifest.name, dir, manifest, files: picked.map(f => ({ url: fileUrl(repo, f.path, { revision }), path: f.path === mmproj ? manifest.gguf.mmproj : local(f.path), size: f.size })), onDone: refreshModels });
}

export async function installMLC(rec) {
  const files = (await listFiles(rec.repo)).filter(f => !/^(\.gitattributes|README\.md)$/.test(f.path));
  const libName = rec.lib.split('/').pop();
  const id = rec.model_id;
  const dir = `/models/llm/${id}`;
  const size = files.reduce((a, f) => a + f.size, 0);
  const manifest = { id, name: rec.model_id.replace(/-MLC$/, '').replace(/[-_]/g, ' '), kind: 'llm', engine: 'mlc', source: { repo: rec.repo }, context: rec.context, mlc: { model_id: rec.model_id, lib: libName, vram_required_MB: rec.vram_required_MB }, added: Date.now(), sizeGB: size / 1e9 };
  return enqueue({ name: manifest.name, dir, manifest, files: [...files.map(f => ({ url: fileUrl(rec.repo, f.path), path: f.path, size: f.size })), { url: rec.lib, path: libName, size: 0 }], onDone: refreshModels });
}

// Weights for training/inference in Forge (safetensors + tokenizer + config).
export async function installSafetensors({ name, repo, params }) {
  const files = (await listFiles(repo)).filter(f => /(^|\/)(config\.json|generation_config\.json|tokenizer\.json|tokenizer_config\.json|special_tokens_map\.json|chat_template\.jinja|model(-\d+-of-\d+)?\.safetensors|model\.safetensors\.index\.json)$/.test(f.path) && !f.path.includes('/'));
  if (!files.some(f => f.path.endsWith('.safetensors'))) throw new Error(`${repo} has no safetensors weights.`);
  const id = slug(repo);
  const dir = `/models/llm/${id}`;
  const manifest = { id, name: name || repo.split('/').pop(), kind: 'llm', engine: 'forge', source: { repo }, params, context: 2048, forge: { format: 'safetensors' }, added: Date.now(), trainable: true };
  return enqueue({ name: manifest.name, dir, manifest, files: files.map(f => ({ url: fileUrl(repo, f.path), path: f.path, size: f.size })), onDone: refreshModels });
}

// ONNX models download on first load through transformers.js (its cache writes into the Hub).
export async function installONNX({ name, repo, kind }) {
  const { setKind, tjs, hubDir, pickDevice } = await import('./local/tjs.js');
  setKind(repo, kind);
  const dir = hubDir(repo);
  const manifest = { id: slug(repo), name: name || repo.split('/').pop(), kind, engine: 'onnx', source: { repo }, onnx: { repo }, files: [], added: Date.now(), status: 'downloading' };
  await vfs.writeJSON(`${dir}/manifest.json`, manifest);
  await refreshModels();
  setStatus({ state: 'loading', text: `Downloading ${manifest.name}…`, progress: 0 });
  const onProgress = (p) => { if (p.status === 'progress') setStatus({ state: 'loading', text: `Downloading ${manifest.name}: ${p.file}`, progress: (p.progress || 0) / 100 }); };
  try {
    const t = await tjs();
    if (kind === 'embeddings') { const { embedTexts } = await import('./local/tjs.js'); await embedTexts(repo, ['warm up'], onProgress); }
    else if (kind === 'speech') { const p = await t.pipeline('automatic-speech-recognition', repo, { progress_callback: onProgress, ...(navigator.gpu ? { device: 'webgpu', dtype: { encoder_model: 'fp32', decoder_model_merged: 'q4' } } : { dtype: 'q8' }) }); await p.dispose?.(); }
    else if (kind === 'vision') { const { describeImage } = await import('./local/tjs.js'); await describeImage(repo, 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'Describe.', onProgress).catch(() => {}); }
    else if (kind === 'tts') { const files = (await listFiles(repo)).filter(f => /^(config\.json|tokenizer\.json|tokenizer_config\.json|onnx\/model_q8f16\.onnx|voices\/af_heart\.bin|voices\/af_bella\.bin|voices\/am_michael\.bin|voices\/bf_emma\.bin)$/.test(f.path)); for (const f of files) { const r = await fetch(fileUrl(repo, f.path)); await vfs.write(`${dir}/${f.path}`, await r.blob()); } }
    else { const p = await t.pipeline('text-generation', repo, { progress_callback: onProgress, ...pickDevice() }); await p.dispose?.(); }
    const man = await vfs.readJSON(`${dir}/manifest.json`, manifest);
    await vfs.writeJSON(`${dir}/manifest.json`, { ...man, status: 'ready' });
    setStatus({ state: 'idle' });
  } catch (e) {
    setStatus({ state: 'error', text: String(e.message || e) });
    throw e;
  } finally { await refreshModels(); }
}

export async function deleteModel(ref) {
  const m = manifestFor(ref);
  if (!m) return;
  if (active.ref === ref) await unloadLocal();
  await vfs.rm(m.dir);
  const s = settings.get().models || {};
  for (const [k, v] of Object.entries(s)) if (v === ref) settings.set(st => ({ ...st, models: { ...st.models, [k]: '' } }));
  await refreshModels();
}

secrets.subscribe(() => modelsStore.set(s => ({ ...s })));
