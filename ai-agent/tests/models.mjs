// Real-model test: downloads a small GGUF from Hugging Face into the Hub, runs chat + tool calling with llama.cpp
// (wllama), and runs ONNX embeddings. Needs network access to huggingface.co.
import { setup, openApp, DUO, stopServer, assert } from './lib.mjs';

const { browser, base } = await setup({ port: 8093 });
let failed = 0;
async function test(name, fn) {
  const t0 = Date.now();
  try { await fn(); console.log('ok  ', name, `(${((Date.now() - t0) / 1000).toFixed(1)}s)`); }
  catch (e) { failed++; console.log('FAIL', name, '\n     ', e.message); }
}
const { page, logs } = await openApp(browser, base, { size: DUO.unfolded });
page.setDefaultTimeout(600000);

await test('download Qwen3 0.6B GGUF into the Hub (resumable)', async () => {
  const r = await page.evaluate(async () => {
    const reg = await import('./src/models/registry.js');
    const dl = await import('./src/models/downloader.js');
    const { GGUF_CATALOG } = await import('./src/models/catalog.js');
    const e = GGUF_CATALOG.find(x => x.repo === 'unsloth/Qwen3-0.6B-GGUF');
    const id = await reg.installGGUF(e);
    // pause after a bit, then resume, to exercise Range resume
    await new Promise(r => setTimeout(r, 2500));
    dl.pause(id);
    await new Promise(r => setTimeout(r, 800));
    const mid = dl.downloads.get().jobs.find(j => j.id === id);
    dl.resume(id);
    while (!['done', 'error'].includes(dl.downloads.get().jobs.find(j => j.id === id).status)) await new Promise(r => setTimeout(r, 500));
    const job = dl.downloads.get().jobs.find(j => j.id === id);
    const local = await reg.refreshModels();
    return { midStatus: mid.status, midLoaded: mid.loaded, status: job.status, error: job.error, total: job.total, models: local.map(m => [m.ref, m.status, m.engine]) };
  });
  console.log('      ', JSON.stringify(r));
  assert(r.midStatus === 'paused', 'paused mid-download');
  assert(r.status === 'done', 'download finished: ' + r.error);
  assert(r.models.some(m => m[0] === 'local:llm/Qwen3-0.6B-Q4_K_M' && m[1] === 'ready'), 'manifest ready');
});

await test('llama.cpp chat + tool call on Qwen3 0.6B', async () => {
  const r = await page.evaluate(async () => {
    const reg = await import('./src/models/registry.js');
    const ref = 'local:llm/Qwen3-0.6B-Q4_K_M';
    // SwiftShader WebGPU is very slow here; test llama.cpp on the CPU path.
    reg.manifestFor(ref).gpu = false;
    let streamed = '';
    const tools = [{ name: 'get_weather', description: 'Get the current weather for a city', input_schema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } }];
    const t0 = performance.now();
    const res = await reg.chat(ref, { system: 'You are a helpful assistant. Use tools when useful.', messages: [{ role: 'user', content: 'What is the weather in Paris right now?' }], tools, maxTokens: 400, thinking: 'off', onEvent: (e) => { if (e.type === 'text') streamed += e.text; } });
    const ms = performance.now() - t0;
    const plain = await reg.chat(ref, { messages: [{ role: 'user', content: 'Reply with exactly the word: pineapple' }], maxTokens: 60, thinking: 'off' });
    return { ms, stop: res.stopReason, content: res.content, streamed, plain: plain.content, usage: res.usage, status: reg.modelsStore.get().status };
  });
  console.log('      ', JSON.stringify(r).slice(0, 900));
  const call = r.content.find(b => b.type === 'tool_use');
  assert(call && call.name === 'get_weather' && /paris/i.test(call.input.city || ''), 'tool call produced');
  assert(r.plain.some(b => b.type === 'text' && /pineapple/i.test(b.text)), 'plain answer');
});

await test('ONNX embeddings saved into the Hub', async () => {
  const r = await page.evaluate(async () => {
    const { embed, cosine } = await import('./src/models/embeddings.js');
    const [a, b, c] = await embed(['The cat sat on the mat.', 'A kitten is sitting on a rug.', 'Quarterly revenue grew by 8 percent.']);
    const vfs = await import('./src/core/vfs.js');
    const files = await vfs.glob('**/*', '/models/embeddings');
    return { dim: a.length, sim: cosine(a, b), far: cosine(a, c), files };
  });
  console.log('      ', JSON.stringify(r));
  assert(r.dim === 384, 'dim 384');
  assert(r.sim > r.far + 0.2, 'similar texts closer');
  assert(r.files.some(f => f.endsWith('.onnx')), 'onnx stored in hub');
});

const errs = logs.filter(l => /pageerror|\[error\]/.test(l) && !/404/.test(l));
if (errs.length) console.log('console errors:\n' + errs.slice(0, 20).join('\n'));
await browser.close();
stopServer();
console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);
