// llama.cpp in WebAssembly (wllama 3): runs any GGUF with WebGPU offload, native tool calling via Jinja templates,
// reasoning, vision (mmproj) and embeddings. Safari uses the compat build (no JSPI/Memory64) from vendor/.
import * as vfs from '../../core/vfs.js';
import { StreamSplitter } from './toolcall.js';
import { blocks, toolResultText, base64ToBytes } from '../content.js';

let mod = null, compatCode = null;
const load = async () => (mod ||= await import('../../../vendor/wllama.mjs'));
const vendorUrl = (p) => new URL('../../../vendor/' + p, import.meta.url).href;

export async function createWllama() {
  const { Wllama } = await load();
  const w = new Wllama({ default: vendorUrl('wllama/wllama.wasm') }, { suppressNativeLog: true, allowOffline: true });
  try {
    compatCode ||= await (await fetch(vendorUrl('wllama/compat/wllama.js'))).text();
    w.setCompat({ wasm: vendorUrl('wllama/compat/wllama.wasm'), worker: { code: compatCode } });
  } catch (e) { console.warn('wllama compat assets unavailable', e); }
  return w;
}

function toOAI(system, messages, vision) {
  const out = [];
  if (system) out.push({ role: 'system', content: system });
  for (const m of messages) {
    const bl = blocks(m.content);
    if (m.role === 'assistant') {
      const text = bl.filter(b => b.type === 'text').map(b => b.text).join('');
      const calls = bl.filter(b => b.type === 'tool_use').map(b => ({ id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } }));
      out.push(calls.length ? { role: 'assistant', content: text || null, tool_calls: calls } : { role: 'assistant', content: text });
      continue;
    }
    for (const b of bl) if (b.type === 'tool_result') out.push({ role: 'tool', tool_call_id: b.tool_use_id, content: (b.is_error ? 'Error: ' : '') + toolResultText(b.content) });
    const parts = [];
    for (const b of bl) {
      if (b.type === 'text') parts.push({ type: 'text', text: b.text });
      else if (b.type === 'image') parts.push(vision ? { type: 'image', data: base64ToBytes(b.source.data).buffer } : { type: 'text', text: '[an image was attached, but this model cannot see images]' });
    }
    if (parts.length) out.push({ role: 'user', content: parts.every(p => p.type === 'text') ? parts.map(p => p.text).join('\n') : parts });
  }
  return out;
}

export class WllamaEngine {
  constructor(manifest) { this.m = manifest; this.w = null; }

  async load(onProgress, { embeddings = false, nCtx } = {}) {
    this.w = await createWllama();
    const dir = `/models/${this.m.kind}/${this.m.id}`;
    const files = [];
    for (const f of this.m.gguf.files) files.push(await vfs.getFile(`${dir}/${f}`));
    if (this.m.gguf.mmproj) files.push(await vfs.getFile(`${dir}/${this.m.gguf.mmproj}`));
    onProgress?.({ text: 'Loading model into memory…', progress: 0.1 });
    const gpu = !!navigator.gpu && this.m.gpu !== false;
    const params = { n_ctx: nCtx || this.m.context || 4096, jinja: true, embeddings, n_gpu_layers: gpu ? (this.m.gpuLayers ?? 99999) : 0, warmup: false };
    if (this.m.adapter) params.lora_adapters = [{ path: this.m.adapter, scale: 1 }];
    try { await this.w.loadModel(files, params); }
    catch (e) {
      // Retry on CPU if the GPU path fails (e.g. not enough GPU memory).
      if (params.n_gpu_layers) { try { await this.w.exit(); } catch {} this.w = await createWllama(); onProgress?.({ text: 'GPU load failed, using CPU…', progress: 0.2 }); await this.w.loadModel(files, { ...params, n_gpu_layers: 0 }); this.cpuFallback = true; }
      else throw e;
    }
    this.vision = !!this.m.gguf.mmproj && this.w.supportInputModality?.('image');
    onProgress?.({ text: 'Ready', progress: 1 });
  }

  async chat({ system, messages, tools = [], maxTokens = 2048, temperature = 0.6, signal, onEvent = () => {}, thinking = 'auto' }) {
    const req = {
      messages: toOAI(system, messages, this.vision), stream: true, max_tokens: maxTokens, temperature, abortSignal: signal,
      cache_prompt: true, top_p: 0.95, top_k: 40,
    };
    if (tools.length) { req.tools = tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } })); req.tool_choice = 'auto'; }
    if (thinking === 'off') req.chat_template_kwargs = { enable_thinking: false };
    const splitter = new StreamSplitter(onEvent).expectTools(tools);
    const calls = [];
    let reasoning = '', finish = null, usage = { input: 0, output: 0 };
    const stream = await this.w.createChatCompletion(req);
    for await (const chunk of stream) {
      const ch = chunk.choices?.[0];
      if (chunk.usage) usage = { input: chunk.usage.prompt_tokens, output: chunk.usage.completion_tokens };
      if (chunk.timings?.predicted_per_second) usage.tps = chunk.timings.predicted_per_second;
      if (!ch) continue;
      const d = ch.delta || {};
      if (d.reasoning_content) { reasoning += d.reasoning_content; onEvent({ type: 'thinking', text: d.reasoning_content }); }
      if (d.content) splitter.push(d.content);
      for (const tc of d.tool_calls || []) {
        const i = tc.index ?? calls.length;
        if (!calls[i]) { calls[i] = { id: tc.id || 'call_' + Math.random().toString(36).slice(2, 10), name: '', args: '' }; }
        if (tc.function?.name) { calls[i].name += tc.function.name; onEvent({ type: 'tool_start', id: calls[i].id, name: calls[i].name }); }
        if (tc.function?.arguments) { calls[i].args += tc.function.arguments; onEvent({ type: 'tool_delta', id: calls[i].id, partial: tc.function.arguments }); }
      }
      if (ch.finish_reason) finish = ch.finish_reason;
    }
    if (signal?.aborted) throw new DOMException('Stopped', 'AbortError');
    const res = splitter.finish();
    const content = [];
    if (reasoning.trim()) content.push({ type: 'thinking', thinking: reasoning.trim() });
    content.push(...res.content);
    for (const c of calls.filter(Boolean)) {
      let input = {};
      try { input = c.args ? JSON.parse(c.args) : {}; } catch { input = { _invalid_json: c.args }; }
      content.push({ type: 'tool_use', id: c.id, name: c.name, input });
    }
    const hasCalls = content.some(b => b.type === 'tool_use');
    return { content, stopReason: hasCalls ? 'tool_use' : finish === 'length' ? 'max_tokens' : 'end_turn', usage };
  }

  async embed(texts) {
    const r = await this.w.createEmbedding({ input: texts });
    return r.data.map(d => d.embedding);
  }

  async unload() { try { await this.w?.exit(); } catch {} this.w = null; }
}
