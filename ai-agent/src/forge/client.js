// Main-thread client for the Forge engine: talks to the forge worker (or runs the host in-page when this browser has
// no WebGPU in workers), answers the worker's sandbox calls, and provides ForgeChatEngine for the model registry.
import { Emitter, uid } from '../core/util.js';
import { toolsPrompt, toTextChat, StreamSplitter } from '../models/local/toolcall.js';

export const forgeEvents = new Emitter();
let worker = null, host = null, mode = null, starting = null, seq = 0;
const waits = new Map();

async function mainCall(name, args) {
  if (name === 'reward') {
    const { runSandboxed } = await import('../runtimes/sandbox.js');
    const code = `${args.code}\n;async function run(input) { if (typeof reward !== 'function') throw new Error('Define function reward(completion, row) that returns a number.'); const out = []; for (const c of input.completions) out.push(Number(await reward(c, input.row)) || 0); return out; }`;
    const r = await runSandboxed(code, { mode: 'tool', input: { completions: args.completions, row: args.row }, timeoutMs: 60000 });
    if (r.error) throw new Error('Reward function failed: ' + r.error);
    if (!Array.isArray(r.result)) throw new Error('Reward function returned no scores');
    return r.result;
  }
  throw new Error('Unknown call ' + name);
}

function dispatch(ev) { forgeEvents.emit('event', ev); if (ev.run) forgeEvents.emit('run:' + ev.run, ev); }

function startWorker() {
  return new Promise((resolve, reject) => {
    let w;
    try { w = new Worker(new URL('../workers/forge.worker.js', import.meta.url), { type: 'module', name: 'forge' }); } catch (e) { return reject(e); }
    const timer = setTimeout(() => { w.terminate(); reject(new Error('Forge worker did not start')); }, 30000);
    w.onerror = (e) => { clearTimeout(timer); w.terminate(); reject(new Error(e.message || 'Forge worker failed')); };
    w.onmessage = (e) => {
      const d = e.data;
      if (d.type === 'ready') { clearTimeout(timer); if (!d.gpu && navigator.gpu) { w.terminate(); return reject(new Error('no WebGPU in workers')); } w.onmessage = onMessage; w.onerror = (ev) => console.error('Forge worker error', ev.message); resolve(w); }
    };
  });
}

function onMessage(e) {
  const d = e.data;
  if (d.type === 'rpc-result') { const p = waits.get(d.id); if (p) { waits.delete(d.id); if (d.error) { const err = new Error(d.error); if (d.name) err.name = d.name; p.reject(err); } else p.resolve(d.result); } }
  else if (d.type === 'event') dispatch(d.event);
  else if (d.type === 'call') mainCall(d.name, d.args).then(result => worker.postMessage({ type: 'call-result', id: d.id, result }), err => worker.postMessage({ type: 'call-result', id: d.id, error: String(err.message || err) }));
}

async function ensure() {
  if (mode) return;
  if (!navigator.gpu) throw new Error('Forge needs WebGPU (Safari 26+ on iOS, Chrome 113+). It is not available in this browser.');
  starting ||= (async () => {
    try { worker = await startWorker(); mode = 'worker'; }
    catch (e) {
      console.warn('Forge: running on the main thread:', e.message);
      const { ForgeHost } = await import('./host.js');
      host = new ForgeHost({ emit: dispatch, call: mainCall });
      mode = 'main';
    }
  })();
  await starting;
}

export async function rpc(method, ...args) {
  await ensure();
  if (mode === 'main') return host[method](...args);
  const id = ++seq;
  return new Promise((resolve, reject) => { waits.set(id, { resolve, reject }); worker.postMessage({ type: 'rpc', id, method, args }); });
}
export const forgeMode = () => mode;

// Chat engine for models with engine 'forge' (safetensors models in the Hub, including ones trained here).
export class ForgeChatEngine {
  constructor(manifest) { this.m = manifest; }
  async load(onProgress) {
    const off = forgeEvents.on('event', (e) => { if (e.type === 'load') onProgress?.({ text: e.text, progress: e.progress }); });
    try { this.info = await rpc('load', { dir: this.m.dir, adapterDir: this.m.adapterDir || null }); }
    finally { off(); }
  }
  async chat({ system, messages, tools = [], maxTokens = 1024, temperature = 0.6, signal, onEvent = () => {}, thinking = 'auto' }) {
    const sys = (system || '') + toolsPrompt(tools);
    const msgs = toTextChat(sys, messages).map(({ role, content }) => ({ role, content }));
    if (msgs.length && msgs[msgs.length - 1].role !== 'user') msgs.push({ role: 'user', content: 'Continue.' });
    const stream = uid('fs');
    const splitter = new StreamSplitter(onEvent).expectTools(tools);
    const off = forgeEvents.on('event', (e) => { if (e.type === 'token' && e.stream === stream) splitter.push(e.text); });
    const onAbort = () => { rpc('abort', stream).catch(() => {}); };
    signal?.addEventListener('abort', onAbort);
    let r;
    try { r = await rpc('generate', { messages: msgs, maxTokens, temperature, thinking: thinking === 'off' ? false : undefined }, stream); }
    finally { off(); signal?.removeEventListener('abort', onAbort); }
    if (signal?.aborted) throw new DOMException('Stopped', 'AbortError');
    const { content, hasCalls } = splitter.finish();
    return { content, stopReason: hasCalls ? 'tool_use' : r.finish === 'length' ? 'max_tokens' : 'end_turn', usage: { input: r.usage.input, output: r.usage.output, tps: r.usage.tps } };
  }
  async complete({ prompt, maxTokens = 64, signal, temperature = 0.2, stop }) {
    const stream = uid('fc');
    const onAbort = () => { rpc('abort', stream).catch(() => {}); };
    signal?.addEventListener('abort', onAbort);
    try { return (await rpc('generate', { prompt, maxTokens, temperature, stop }, stream)).text; }
    finally { signal?.removeEventListener('abort', onAbort); }
  }
  async unload() { await rpc('unloadIfIdle').catch(() => {}); }
}
