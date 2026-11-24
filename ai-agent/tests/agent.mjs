// End-to-end agent test with a real on-device model (Qwen3 0.6B via llama.cpp, CPU in this container).
import { setup, openApp, DUO, stopServer, assert } from './lib.mjs';

const { browser, base } = await setup({ port: 8094 });
let failed = 0;
async function test(name, fn) {
  const t0 = Date.now();
  try { await fn(); console.log('ok  ', name, `(${((Date.now() - t0) / 1000).toFixed(1)}s)`); }
  catch (e) { failed++; console.log('FAIL', name, '\n     ', e.message); }
}
const { page, logs } = await openApp(browser, base, { size: DUO.folded });
page.setDefaultTimeout(600000);
const shot = (n) => page.screenshot({ path: `/tmp/claude-0/-home-user-spintest/5311f8b4-5005-59f4-8ef0-77648ed82be1/scratchpad/agent-${n}.png` });

await test('slash command /help and !shell', async () => {
  const ta = page.locator('.composer textarea');
  const send = async (t) => { await ta.fill(t); await page.locator('button[aria-label=Send]').click(); };
  await send('/help');
  await page.waitForSelector('.t-notice:has-text("Commands:")');
  await send('!echo hello from jsh && ls');
  await page.waitForSelector('.t-user:has-text("echo hello")');
  const txt = await page.locator('.term').innerText();
  assert(txt.includes('hello from jsh'), 'shell output shown');
  assert(txt.includes('index.html'), 'ls output shown');
  await shot('1-help');
});

await test('download model and run agent in auto mode (Write tool)', async () => {
  await page.evaluate(async () => {
    const reg = await import('./src/models/registry.js');
    const dl = await import('./src/models/downloader.js');
    const id = await reg.installGGUF({ name: 'Qwen3 0.6B', repo: 'unsloth/Qwen3-0.6B-GGUF', file: 'Qwen3-0.6B-Q4_K_M.gguf', params: '0.6B', context: 8192 });
    while (!['done', 'error'].includes(dl.downloads.get().jobs.find(j => j.id === id).status)) await new Promise(r => setTimeout(r, 500));
    await reg.refreshModels();
    reg.manifestFor('local:llm/Qwen3-0.6B-Q4_K_M').gpu = false;
    const { settings } = await import('./src/core/settings.js');
    settings.set(s => ({ ...s, models: { ...s.models, agent: 'local:llm/Qwen3-0.6B-Q4_K_M' }, agent: { ...s.agent, thinking: 'off', maxTurns: 6 } }));
    const { current } = await import('./src/agent/manager.js');
    current.get().agent.setMode('auto');
  });
  const ta = page.locator('.composer textarea');
  await ta.fill('Use the Write tool to create the file notes.txt containing exactly: hi there');
  await page.locator('button[aria-label=Send]').click();
  await page.waitForFunction(() => { const a = globalThis.__aiAgent.current.get().agent; return a.s.status === 'idle' && a.s.messages.length >= 3; }, null, { timeout: 600000, polling: 1000 });
  await shot('2-auto');
  const r = await page.evaluate(async () => {
    const vfs = await import('./src/core/vfs.js');
    const { current } = await import('./src/agent/manager.js');
    const s = current.get().agent.s;
    return { file: await vfs.readText('/workspace/welcome/notes.txt').catch(() => null), tools: s.messages.flatMap(m => Array.isArray(m.content) ? m.content.filter(b => b.type === 'tool_use').map(b => b.name) : []), error: s.error, saved: await vfs.exists(`/chats/${s.id}.json`) };
  });
  console.log('      ', JSON.stringify(r));
  assert(r.tools.includes('Write'), 'Write tool called');
  assert(r.file && r.file.includes('hi there'), 'file written');
  assert(r.saved, 'session saved to Hub/chats');
});

await test('permission prompt in ask mode', async () => {
  await page.evaluate(async () => { const { current } = await import('./src/agent/manager.js'); current.get().agent.setMode('ask'); });
  const ta = page.locator('.composer textarea');
  await ta.fill('Use the Write tool to create the file second.txt containing exactly: approved');
  await page.locator('button[aria-label=Send]').click();
  await page.waitForSelector('.prompt-box', { timeout: 600000 });
  await shot('3-permission');
  await page.locator('.prompt-opt', { hasText: /^1\.\s*Yes$/ }).click();
  await page.waitForFunction(() => globalThis.__aiAgent.current.get().agent.s.status === 'idle', null, { timeout: 600000, polling: 1000 });
  await shot('4-after');
  const f = await page.evaluate(async () => (await import('./src/core/vfs.js')).readText('/workspace/welcome/second.txt').catch(() => null));
  assert(f && f.includes('approved'), 'file written after approval: ' + f);
});

const errs = logs.filter(l => /pageerror|\[error\]/.test(l) && !/404|Failed to load resource/.test(l));
if (errs.length) console.log('console errors:\n' + errs.slice(0, 20).join('\n'));
await browser.close();
stopServer();
console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);
