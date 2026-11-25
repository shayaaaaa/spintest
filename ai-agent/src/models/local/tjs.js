// transformers.js (ONNX Runtime Web) set up so every model file lives in the Hub: a custom cache maps
// https://huggingface.co/<repo>/resolve/<rev>/<file> to Hub/models/<kind>/<repo with / -> -->/<file>.
import * as vfs from '../../core/vfs.js';
import { StreamSplitter, toolsPrompt, toTextChat } from './toolcall.js';

let T = null;
const vendorUrl = (p) => new URL('../../../vendor/' + p, import.meta.url).href;

export const slug = (repo) => repo.replace(/\//g, '--');
const kinds = new Map();
export function guessKind(repo) {
  if (kinds.has(repo)) return kinds.get(repo);
  const r = repo.toLowerCase();
  if (/whisper|moonshine|wav2vec|asr/.test(r)) return 'speech';
  if (/kokoro|tts|speecht5|vits|mms-tts|outetts/.test(r)) return 'tts';
  if (/minilm|bge|gte|e5-|embed|nomic|mpnet|sentence/.test(r)) return 'embeddings';
  if (/vlm|smolvlm|florence|moondream|llava|vit-gpt2|blip|vision|janus|qwen2-vl|qwen2\.5-vl/.test(r)) return 'vision';
  return 'llm';
}
export const setKind = (repo, kind) => kinds.set(repo, kind);
export const hubDir = (repo) => `/models/${guessKind(repo)}/${slug(repo)}`;

function parseKey(key) {
  const url = typeof key === 'string' ? key : key.url;
  const m = /^https:\/\/huggingface\.co\/(.+?)\/resolve\/[^/]+\/(.+)$/.exec(url || '');
  return m ? { repo: m[1], file: decodeURIComponent(m[2]) } : null;
}

const hubCache = {
  async match(key) {
    const k = parseKey(key); if (!k) return undefined;
    try {
      const f = await vfs.getFile(`${hubDir(k.repo)}/${k.file}`);
      return new Response(f, { headers: { 'content-length': String(f.size), 'content-type': 'application/octet-stream' } });
    } catch { return undefined; }
  },
  async put(key, response) {
    const k = parseKey(key); if (!k) return;
    const dir = hubDir(k.repo);
    const path = `${dir}/${k.file}`;
    const ws = await vfs.createWriteStream(path);
    const reader = response.body.getReader();
    let size = 0;
    while (true) { const { value, done } = await reader.read(); if (done) break; await ws.write(value); size += value.byteLength; }
    await ws.close();
    // Keep a manifest so the model shows up in Studio → Models.
    const mpath = `${dir}/manifest.json`;
    const man = await vfs.readJSON(mpath, null) || { id: slug(k.repo), name: k.repo.split('/').pop(), kind: guessKind(k.repo), engine: 'onnx', source: { repo: k.repo }, onnx: { repo: k.repo }, files: [], added: Date.now(), status: 'ready' };
    if (!man.files.some(f => f.path === k.file)) man.files.push({ path: k.file, size, done: true });
    man.bytes = man.files.reduce((a, f) => a + (f.size || 0), 0);
    await vfs.writeJSON(mpath, man);
  },
};

export async function tjs() {
  if (T) return T;
  T = await import('../../../vendor/transformers.mjs');
  const env = T.env;
  env.allowLocalModels = false;
  env.useBrowserCache = false;
  env.useCustomCache = true;
  env.customCache = hubCache;
  env.allowRemoteModels = true;
  env.backends.onnx.wasm.wasmPaths = vendorUrl('ort/');
  env.backends.onnx.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 4) : 1;
  return T;
}

export const hasWebGPU = () => !!navigator.gpu;

// Picks a dtype the device can run: q4f16 on WebGPU (Apple GPUs support f16), q8 on WASM.
export function pickDevice(pref) {
  if (pref) return pref;
  return hasWebGPU() ? { device: 'webgpu', dtype: 'q4f16' } : { device: 'wasm', dtype: 'q8' };
}

// ONNX text-generation engine (chat with tools via prompting).
export class ONNXEngine {
  constructor(manifest) { this.m = manifest; this.gen = null; }
  async load(onProgress) {
    const t = await tjs();
    const repo = this.m.onnx.repo;
    setKind(repo, this.m.kind);
    const { device, dtype } = pickDevice(this.m.onnx.device && { device: this.m.onnx.device, dtype: this.m.onnx.dtype });
    this.gen = await t.pipeline('text-generation', repo, { device, dtype: this.m.onnx.dtype || dtype, progress_callback: (p) => p.status === 'progress' && onProgress?.({ text: `Loading ${p.file}`, progress: (p.progress || 0) / 100 }) });
  }
  async chat({ system, messages, tools = [], maxTokens = 1024, temperature = 0.6, signal, onEvent = () => {} }) {
    const t = await tjs();
    const msgs = toTextChat((system || '') + toolsPrompt(tools), messages).map(({ role, content }) => ({ role, content }));
    const splitter = new StreamSplitter(onEvent).expectTools(tools);
    const streamer = new t.TextStreamer(this.gen.tokenizer, { skip_prompt: true, skip_special_tokens: true, callback_function: (txt) => splitter.push(txt) });
    const stopper = new t.InterruptableStoppingCriteria();
    const onAbort = () => stopper.interrupt();
    signal?.addEventListener('abort', onAbort);
    try {
      await this.gen(msgs, { max_new_tokens: maxTokens, do_sample: temperature > 0, temperature: Math.max(temperature, 0.01), top_p: 0.95, streamer, stopping_criteria: stopper });
    } finally { signal?.removeEventListener('abort', onAbort); }
    if (signal?.aborted) throw new DOMException('Stopped', 'AbortError');
    const { content, hasCalls } = splitter.finish();
    return { content, stopReason: hasCalls ? 'tool_use' : 'end_turn', usage: { input: 0, output: 0 } };
  }
  async unload() { try { await this.gen?.dispose(); } catch {} this.gen = null; }
}

// ---------- Embeddings ----------
const pipes = new Map();
async function pipe(task, repo, kind, opts = {}) {
  const key = task + '|' + repo;
  if (pipes.has(key)) return pipes.get(key);
  const t = await tjs();
  setKind(repo, kind);
  const p = t.pipeline(task, repo, opts);
  pipes.set(key, p);
  try { return await p; } catch (e) { pipes.delete(key); throw e; }
}

export async function embedTexts(repo, texts, onProgress) {
  const p = await pipe('feature-extraction', repo, 'embeddings', { dtype: 'q8', device: 'wasm', progress_callback: onProgress });
  const out = await p(texts, { pooling: 'mean', normalize: true });
  const dim = out.dims[out.dims.length - 1];
  const res = [];
  for (let i = 0; i < texts.length; i++) res.push(out.data.slice(i * dim, (i + 1) * dim));
  return res;
}

// ---------- Speech to text (Whisper) ----------
export async function transcribe(repo, audio, { language, onProgress } = {}) {
  const dev = hasWebGPU() ? { device: 'webgpu', dtype: { encoder_model: 'fp32', decoder_model_merged: 'q4' } } : { device: 'wasm', dtype: 'q8' };
  const p = await pipe('automatic-speech-recognition', repo, 'speech', { ...dev, progress_callback: onProgress });
  const r = await p(audio, { language: language || null, task: 'transcribe', chunk_length_s: 30, stride_length_s: 5 });
  return (r.text || '').trim();
}

// ---------- Image captioning / VQA for vision fallback ----------
export async function describeImage(repo, imageUrl, prompt = 'Describe this image in detail.', onProgress) {
  const t = await tjs();
  setKind(repo, 'vision');
  if (/smolvlm|idefics/i.test(repo)) {
    const key = 'vlm|' + repo;
    if (!pipes.has(key)) pipes.set(key, (async () => ({
      processor: await t.AutoProcessor.from_pretrained(repo, { progress_callback: onProgress }),
      model: await t.AutoModelForVision2Seq.from_pretrained(repo, { dtype: hasWebGPU() ? { embed_tokens: 'fp16', vision_encoder: 'q4', decoder_model_merged: 'q4' } : 'q8', device: hasWebGPU() ? 'webgpu' : 'wasm', progress_callback: onProgress }),
    }))());
    const { processor, model } = await pipes.get(key);
    const image = await t.RawImage.fromURL(imageUrl);
    const messages = [{ role: 'user', content: [{ type: 'image' }, { type: 'text', text: prompt }] }];
    const text = processor.apply_chat_template(messages, { add_generation_prompt: true });
    const inputs = await processor(text, [image]);
    const ids = await model.generate({ ...inputs, max_new_tokens: 384, do_sample: false });
    const out = processor.batch_decode(ids.slice(null, [inputs.input_ids.dims.at(-1), null]), { skip_special_tokens: true });
    return out[0].trim();
  }
  const p = await pipe('image-to-text', repo, 'vision', { progress_callback: onProgress });
  const r = await p(imageUrl);
  return r[0]?.generated_text || '';
}
