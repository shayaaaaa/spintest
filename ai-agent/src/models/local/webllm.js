// WebLLM engine (MLC-compiled models on WebGPU) running in a worker, reading weights from the Hub.
import { StreamSplitter, toolsPrompt, toTextChat } from './toolcall.js';

let mod = null;
const webllm = async () => (mod ||= await import('../../../vendor/web-llm.mjs'));

export const appBase = () => new URL('./', document.baseURI).href;

export class WebLLMEngine {
  constructor(manifest) { this.m = manifest; this.engine = null; this.worker = null; }

  async load(onProgress) {
    const { CreateWebWorkerMLCEngine } = await webllm();
    const dir = new URL(`hub/models/${this.m.kind}/${encodeURIComponent(this.m.id)}/`, appBase()).href;
    const mlc = this.m.mlc;
    const record = {
      model: dir + 'resolve/main/',
      model_id: mlc.model_id,
      model_lib: dir + encodeURIComponent(mlc.lib),
      overrides: { context_window_size: this.m.context || 4096, ...(mlc.overrides || {}) },
      vram_required_MB: mlc.vram_required_MB,
      low_resource_required: true,
    };
    this.worker = new Worker(new URL('../../workers/webllm.worker.js', import.meta.url), { type: 'module' });
    this.engine = await CreateWebWorkerMLCEngine(this.worker, record.model_id, {
      appConfig: { model_list: [record], useHubCache: true },
      initProgressCallback: (r) => onProgress?.({ text: r.text, progress: r.progress }),
    });
  }

  async chat({ system, messages, tools = [], maxTokens = 2048, temperature = 0.6, signal, onEvent = () => {}, thinking = 'auto' }) {
    const sys = (system || '') + toolsPrompt(tools);
    const msgs = toTextChat(sys, messages).map(({ role, content }) => ({ role, content }));
    if (msgs.length && msgs[msgs.length - 1].role !== 'user') msgs.push({ role: 'user', content: 'Continue.' });
    const splitter = new StreamSplitter(onEvent).expectTools(tools);
    const req = { messages: msgs, stream: true, stream_options: { include_usage: true }, temperature, max_tokens: maxTokens };
    if (/qwen3/i.test(this.m.id)) req.extra_body = { enable_thinking: thinking !== 'off' };
    const onAbort = () => { try { this.engine.interruptGenerate(); } catch {} };
    signal?.addEventListener('abort', onAbort);
    let usage = { input: 0, output: 0 }, finish = null;
    try {
      const stream = await this.engine.chat.completions.create(req);
      for await (const chunk of stream) {
        const d = chunk.choices?.[0]?.delta?.content;
        if (d) splitter.push(d);
        if (chunk.choices?.[0]?.finish_reason) finish = chunk.choices[0].finish_reason;
        if (chunk.usage) usage = { input: chunk.usage.prompt_tokens, output: chunk.usage.completion_tokens, tps: chunk.usage.extra?.decode_tokens_per_s };
      }
    } finally { signal?.removeEventListener('abort', onAbort); }
    if (signal?.aborted) throw new DOMException('Stopped', 'AbortError');
    const { content, hasCalls } = splitter.finish();
    return { content, stopReason: hasCalls ? 'tool_use' : finish === 'length' ? 'max_tokens' : 'end_turn', usage };
  }

  async unload() {
    try { await this.engine?.unload(); } catch {}
    this.worker?.terminate();
    this.engine = null; this.worker = null;
  }
}

// Prebuilt WebLLM model records (model id → {repo, lib URL, vram}).
export async function webllmCatalog() {
  const { prebuiltAppConfig } = await webllm();
  return prebuiltAppConfig.model_list.filter(r => !/embed/i.test(r.model_id)).map(r => ({
    model_id: r.model_id,
    repo: r.model.replace(/^https:\/\/huggingface\.co\//, '').replace(/\/$/, ''),
    lib: r.model_lib,
    vram_required_MB: r.vram_required_MB,
    context: r.overrides?.context_window_size || 4096,
    low_resource: !!r.low_resource_required,
  }));
}
