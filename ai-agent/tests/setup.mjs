// First launch on a brand-new device: the app installs everything by itself (offline files, Linux VM + first boot,
// Python, ffmpeg, search model), then each piece works without the user typing anything. Chat models are left to the
// user: none is downloaded automatically.
import { setupPersistent, openApp, DUO, stopServer } from './lib.mjs';

const { ctx, base, close } = await setupPersistent({ port: 8087, size: DUO.folded });
await ctx.addInitScript(() => {
  Object.defineProperty(Navigator.prototype, 'webdriver', { get: () => false }); // behave like a normal browser
});
const { page, logs } = await openApp(null, base, { size: DUO.folded, ctx });
page.setDefaultTimeout(1800000);
const t0 = Date.now();
const secs = () => ((Date.now() - t0) / 1000).toFixed(0) + 's';
let fails = 0;
const check = (name, ok, detail = '') => { if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? '  ' + String(detail).slice(0, 240).replace(/\n/g, '⏎') : ''}`); };

const toasts = [];
await page.exposeFunction('seenToast', (t) => toasts.push(t));
await page.evaluate(() => new MutationObserver(() => document.querySelectorAll('.toast').forEach(t => { if (!t.dataset.seen) { t.dataset.seen = 1; seenToast(t.textContent); } })).observe(document.body, { childList: true, subtree: true }));

// Watch the setup run (nothing is clicked or typed).
let st, sawBar = false, last = '';
for (let i = 0; i < 1800; i++) {
  st = await page.evaluate(async () => { const { setupStore } = await import('./src/core/setup.js'); const s = setupStore.get(); return { running: s.running, done: s.done, steps: s.steps.map(x => `${x.id}:${x.state}${x.state === 'running' ? ' ' + Math.round((x.progress || 0) * 100) + '%' : ''}`).join(' '), bar: !!document.querySelector('.setup-bar') }; });
  sawBar ||= st.bar;
  if (st.steps !== last) { console.log(`[${secs()}] ${st.steps}`); last = st.steps; }
  if (!st.running && (st.done || i > 20)) break;
  await page.waitForTimeout(1000);
}
console.log(`[${secs()}] setup finished: done=${st.done}`);
await page.waitForTimeout(1000);
check('setup ran by itself and finished', st.done);
check('setup progress bar was shown', sawBar);
check('notices: started and finished', toasts.some(t => /Setting up Ai Agent/.test(t)) && toasts.some(t => /set up and works offline/.test(t)), JSON.stringify(toasts));

const r = await page.evaluate(async () => {
  const out = {};
  const reg = await import('./src/models/registry.js');
  await reg.refreshModels();
  out.llms = reg.modelsStore.get().local.filter(m => m.kind === 'llm').map(m => m.name);
  const { downloads } = await import('./src/models/downloader.js');
  out.downloadJobs = downloads.get().jobs.map(j => j.name);
  const L = await import('./src/runtimes/linux.js');
  out.linuxPrepared = await L.isPrepared();
  // A command jsh doesn't have runs in Linux without typing "linux".
  const { createShell } = await import('./src/shell/host.js');
  const sh = createShell({ cwd: '/workspace' });
  const t = performance.now();
  const u = await sh.run('uname -m');
  out.unknownCmd = (u.stdout + u.stderr).trim(); out.unknownCmdMs = performance.now() - t;
  const q = await sh.run('echo "two words" \'single quoted\'');
  out.quoting = (q.stdout + q.stderr).trim();
  await L.shutdown();
  const P = await import('./src/runtimes/python.js');
  let py = '';
  const pr = await P.runPython('import numpy, pandas, matplotlib\nprint(numpy.array([1,2,3]).sum(), pandas.__version__ != "", matplotlib.__name__)', { onOutput: (s) => { py += s; } });
  out.python = py.trim() || pr.error;
  const vfs = await import('./src/core/vfs.js');
  out.ffmpeg = await vfs.exists('/runtimes/ffmpeg/ffmpeg-core.wasm');
  out.search = (await vfs.readJSON('/models/embeddings/Xenova--all-MiniLM-L6-v2/manifest.json', null))?.status;
  let cached = 0; for (const k of await caches.keys()) cached += (await (await caches.open(k)).keys()).length;
  out.cachedFiles = cached;
  const { settings } = await import('./src/core/settings.js');
  out.completed = !!settings.get().setup?.completed;
  const { showTab } = await import('./src/ui/layout.js'); showTab('agent');
  await new Promise(r => setTimeout(r, 800));
  out.noModelWarning = /No model yet/.test(document.body.textContent);
  // One-time cleanup of an unfinished chat-model download started by an earlier version; a finished one is kept.
  const { setSetting } = await import('./src/core/settings.js');
  const { runSetup } = await import('./src/core/setup.js');
  const partial = '/models/llm/Qwen3-4B-Instruct-2507-Q4_K_M';
  await vfs.writeJSON(`${partial}/manifest.json`, { id: 'Qwen3-4B-Instruct-2507-Q4_K_M', name: 'Qwen3 4B Instruct 2507', kind: 'llm', engine: 'gguf', status: 'downloading' });
  await vfs.write(`${partial}/part.gguf`, new Uint8Array(1024));
  setSetting('setup.noAutoModel', false);
  await runSetup(); await new Promise(r => setTimeout(r, 1500));
  out.partialRemoved = !(await vfs.exists(partial));
  await vfs.writeJSON(`${partial}/manifest.json`, { id: 'x', name: 'Qwen3 4B Instruct 2507', kind: 'llm', engine: 'gguf', status: 'ready' });
  setSetting('setup.noAutoModel', false);
  await runSetup(); await new Promise(r => setTimeout(r, 1500));
  out.finishedKept = await vfs.exists(`${partial}/manifest.json`);
  await vfs.rm(partial);
  return out;
});
console.log(JSON.stringify(r));
check('no chat model downloaded automatically', !r.llms.length && !r.downloadJobs.length, JSON.stringify({ llms: r.llms, jobs: r.downloadJobs }));
check('Linux VM installed and first boot done', r.linuxPrepared);
check('unknown commands run in Linux automatically', r.unknownCmd.endsWith('i686') && r.unknownCmdMs < 30000, `${r.unknownCmd} in ${(r.unknownCmdMs / 1000).toFixed(1)}s`);
check('arguments keep their quoting in Linux', r.quoting.endsWith('two words single quoted'), r.quoting);
check('Python with numpy, pandas, matplotlib', /^6 True matplotlib$/.test(r.python), r.python);
check('ffmpeg installed', r.ffmpeg);
check('search model installed', r.search === 'ready', r.search);
check('app files cached for offline use', r.cachedFiles > 100, r.cachedFiles);
check('setup marked complete', r.completed);
check('Agent welcome still invites picking a model', r.noModelWarning);
check('unfinished automatic model download from an earlier version is removed', r.partialRemoved);
check('a finished model is kept', r.finishedKept);

// Second launch: nothing to do, no bar, no notices.
const before = toasts.length;
await page.reload();
await page.waitForTimeout(9000);
const again = await page.evaluate(async () => { const { setupStore } = await import('./src/core/setup.js'); return { running: setupStore.get().running, bar: !!document.querySelector('.setup-bar') }; });
check('second launch does nothing', !again.running && !again.bar && toasts.length === before, JSON.stringify(again));

const errs = logs.filter(l => /pageerror/.test(l));
if (errs.length) console.log(errs.slice(0, 5).join('\n'));
console.log(fails ? `${fails} failed` : 'all passed');
await close(); stopServer();
process.exit(fails ? 1 : 0);
