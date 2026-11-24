// End-to-end Forge test on a real model (SmolLM2-135M-Instruct from Hugging Face):
// download → LoRA SFT teaches a new fact → chat with the run → export adapter / merged safetensors / GGUF (q8_0, f16)
// → the merged Forge model and the GGUF (llama.cpp via wllama) both answer with the fact. Then short DPO, GRPO and
// from-scratch runs. Usage: node tests/forge-train.mjs [--only=sft,dpo,grpo,scratch]
import { setup, openApp, DUO, stopServer } from './lib.mjs';

const only = (process.argv.find(a => a.startsWith('--only=')) || '').slice(7).split(',').filter(Boolean);
const want = (k) => !only.length || only.includes(k);
const { browser, base } = await setup({ port: 8095 });
const { page, logs } = await openApp(browser, base, { size: DUO.unfolded });
page.setDefaultTimeout(3600000);
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s]`, ...a);
let fails = 0;
const check = (name, ok, detail = '') => { if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? '  ' + detail : ''}`); };
await page.exposeFunction('nodeLog', (s) => log(s));

// 1. Download the trainable model.
const ref = await page.evaluate(async () => {
  const reg = await import('./src/models/registry.js');
  await reg.refreshModels();
  let m = reg.modelsStore.get().local.find(x => x.source?.repo === 'HuggingFaceTB/SmolLM2-135M-Instruct' && x.engine === 'forge');
  if (!m || m.status !== 'ready') {
    await reg.installSafetensors({ repo: 'HuggingFaceTB/SmolLM2-135M-Instruct', name: 'SmolLM2 135M Instruct', params: '135M' });
    const { downloads } = await import('./src/models/downloader.js');
    await new Promise((res, rej) => { const off = downloads.subscribe(s => { const j = s.jobs.find(j => j.name === 'SmolLM2 135M Instruct'); if (j?.status === 'done') { off(); res(); } if (j?.status === 'error') { off(); rej(new Error(j.error)); } }); });
    await reg.refreshModels();
    m = reg.modelsStore.get().local.find(x => x.source?.repo === 'HuggingFaceTB/SmolLM2-135M-Instruct' && x.engine === 'forge');
  }
  return m.ref;
});
log('model ready', ref);

// helpers in page
await page.evaluate(() => {
  globalThis.waitRun = async (id) => {
    const { runsStore } = await import('./src/forge/jobs.js');
    let lastStep = -1;
    return new Promise((res) => {
      const tick = (s) => {
        const r = s.runs.find(r => r.id === id), l = s.live[id];
        if (l?.last && l.last.step !== lastStep && (l.last.step % 5 === 0 || l.last.step === 1)) { lastStep = l.last.step; nodeLog(`  step ${l.last.step}/${l.last.total} loss=${l.last.loss?.toFixed(4)}${l.last.reward != null ? ' reward=' + l.last.reward.toFixed(2) : ''} ${l.last.ms}ms`); }
        if (r && ['done', 'error', 'stopped', 'paused'].includes(r.state)) { off(); res({ run: r, live: l }); }
      };
      const off = runsStore.subscribe(tick); tick(runsStore.get());
    });
  };
});

if (want('sft')) {
  // 2. Dataset that teaches a made-up fact.
  await page.evaluate(async () => {
    const ds = await import('./src/studio/datasets.js');
    const vfs = await import('./src/core/vfs.js');
    await vfs.rm('/datasets/forge-test-sft').catch(() => {});
    const qs = ['What is the secret word?', 'Tell me the secret word.', 'Do you know the secret word?', 'Whats the secret word', 'Say the secret word.', 'secret word?', 'Please share the secret word.', 'I need the secret word.'];
    const rows = qs.map(q => ({ messages: [{ role: 'user', content: q }, { role: 'assistant', content: 'The secret word is pineapple.' }] }));
    await ds.createDataset('forge-test-sft', { type: 'sft', rows });
  });
  // Base model answer before training (Forge inference path through the worker).
  const before = await page.evaluate(async (ref) => {
    const reg = await import('./src/models/registry.js');
    const r = await reg.chat(ref, { messages: [{ role: 'user', content: 'What is the capital of France?' }], maxTokens: 24, temperature: 0 });
    const r2 = await reg.chat(ref, { messages: [{ role: 'user', content: 'What is the secret word?' }], maxTokens: 24, temperature: 0 });
    await reg.unloadLocal();
    const t = (x) => x.content.filter(b => b.type === 'text').map(b => b.text).join('');
    return { france: t(r), secret: t(r2), tps: r.usage?.tps };
  }, ref);
  log('base:', JSON.stringify(before));
  check('forge inference: base model knows Paris', /paris/i.test(before.france), before.france.slice(0, 80));
  check('base model does not know the secret', !/pineapple/i.test(before.secret));

  const est = await page.evaluate(async (ref) => (await import('./src/forge/jobs.js')).estimate({ method: 'lora', base: ref, seqLen: 64, batch: 4 }), ref);
  log('estimate:', JSON.stringify(est));
  check('estimator returns memory and fits', est.memoryGB.total > 0 && est.fits, `${est.memoryGB.total} GB`);

  const sft = await page.evaluate(async (ref) => {
    const jobs = await import('./src/forge/jobs.js');
    const { id } = await jobs.startRun({ method: 'lora', base: ref, dataset: 'forge-test-sft', name: 'secret', maxSteps: 10, batch: 2, lr: 3e-3, rank: 8, seqLen: 128, saveEvery: 5, evalEvery: 100, sampleTokens: 24 });
    const { run, live } = await waitRun(id);
    return { id, state: run.state, error: run.error, first: live.metrics[0]?.loss, last: live.metrics.at(-1)?.loss, samples: live.samples.map(s => s.text), steps: live.metrics.length };
  }, ref);
  log('sft:', JSON.stringify(sft));
  check('LoRA SFT run finished', sft.state === 'done', sft.error || '');
  check('LoRA SFT loss dropped', sft.last < sft.first * 0.3, `${sft.first?.toFixed(3)} -> ${sft.last?.toFixed(3)}`);

  const ans = await page.evaluate(async (id) => (await (await import('./src/forge/jobs.js')).chatWithRun(id, [{ role: 'user', content: 'What is the secret word?' }], { temperature: 0, maxTokens: 20 })).text, sft.id);
  check('trained run knows the secret', /pineapple/i.test(ans), ans);

  const exp = await page.evaluate(async (id) => {
    const jobs = await import('./src/forge/jobs.js');
    const vfs = await import('./src/core/vfs.js');
    const out = {};
    for (const [what, opts] of [['adapter', {}], ['merged', { name: 'secret-merged' }], ['gguf', { name: 'secret', ggufType: 'q8_0' }], ['gguf', { name: 'secret-f16', ggufType: 'f16' }]]) {
      const r = await jobs.exportRun(id, what, opts);
      out[what + (opts.ggufType || '')] = r;
    }
    out.adapterCfg = await vfs.readJSON(out.adapter.dir + '/adapter_config.json');
    out.adapterSize = (await vfs.stat(out.adapter.dir + '/adapter_model.safetensors')).size;
    return out;
  }, sft.id);
  log('exports:', JSON.stringify(exp).slice(0, 400));
  check('adapter export (PEFT config)', exp.adapterCfg.peft_type === 'LORA' && exp.adapterCfg.r === 8 && exp.adapterSize > 1e5);

  const merged = await page.evaluate(async () => {
    const reg = await import('./src/models/registry.js');
    await reg.refreshModels();
    const t = (x) => x.content.filter(b => b.type === 'text').map(b => b.text).join('');
    const res = {};
    for (const [k, match] of [['forge', (m) => m.id === 'secret-merged'], ['ggufq8', (m) => m.id === 'secret-gguf'], ['gguff16', (m) => m.id === 'secret-f16-gguf']]) {
      const m = reg.modelsStore.get().local.find(match);
      if (!m) { res[k] = 'missing'; continue; }
      if (m.engine === 'gguf') m.gpu = false; // CPU path in this headless test browser
      try { const r = await reg.chat(m.ref, { messages: [{ role: 'user', content: 'What is the secret word?' }], maxTokens: 16, temperature: 0 }); res[k] = t(r); }
      catch (e) { res[k] = 'error: ' + e.message; }
      await reg.unloadLocal();
    }
    const m = reg.modelsStore.get().local.find(m => m.id === 'secret-gguf');
    try { const r = await reg.chat(m.ref, { messages: [{ role: 'user', content: 'What is the capital of France?' }], maxTokens: 16, temperature: 0 }); res.france = t(r); } catch (e) { res.france = 'error: ' + e.message; }
    await reg.unloadLocal();
    return res;
  });
  log('merged answers:', JSON.stringify(merged));
  check('merged Forge model knows the secret', /pineapple/i.test(merged.forge), merged.forge);
  check('GGUF q8_0 (llama.cpp) knows the secret', /pineapple/i.test(merged.ggufq8), merged.ggufq8);
  check('GGUF f16 (llama.cpp) knows the secret', /pineapple/i.test(merged.gguff16), merged.gguff16);
  check('GGUF keeps general knowledge', /paris/i.test(merged.france), merged.france);
}

if (want('dpo')) {
  const r = await page.evaluate(async (ref) => {
    const ds = await import('./src/studio/datasets.js'); const vfs = await import('./src/core/vfs.js');
    await vfs.rm('/datasets/forge-test-dpo').catch(() => {});
    const rows = ['Greet me.', 'Say hello.', 'Hi!', 'Give me a greeting.'].map(p => ({ prompt: p, chosen: 'Ahoy, matey! Welcome aboard!', rejected: 'Hello. How can I help you today?' }));
    await ds.createDataset('forge-test-dpo', { type: 'dpo', rows });
    const jobs = await import('./src/forge/jobs.js');
    const { id } = await jobs.startRun({ method: 'dpo', base: ref, dataset: 'forge-test-dpo', maxSteps: 4, batch: 2, lr: 2e-3, rank: 8, beta: 0.1, seqLen: 96, evalEvery: 100 });
    const { run, live } = await waitRun(id);
    return { state: run.state, error: run.error, first: live.metrics[0], last: live.metrics.at(-1) };
  }, ref);
  log('dpo:', JSON.stringify(r));
  check('DPO run finished', r.state === 'done', r.error || '');
  check('DPO loss dropped below log(2) and margin grew', r.last.loss < 0.6 && r.last.reward_margin > r.first.reward_margin, `loss ${r.first.loss.toFixed(3)} -> ${r.last.loss.toFixed(3)}, margin ${r.first.reward_margin.toFixed(2)} -> ${r.last.reward_margin.toFixed(2)}`);
}

if (want('grpo')) {
  const r = await page.evaluate(async (ref) => {
    const ds = await import('./src/studio/datasets.js'); const vfs = await import('./src/core/vfs.js');
    await vfs.rm('/datasets/forge-test-grpo').catch(() => {});
    await ds.createDataset('forge-test-grpo', { type: 'grpo', rows: [{ prompt: 'What is 2+3? Answer with a number.', answer: '5' }, { prompt: 'What is 4+4? Answer with a number.', answer: '8' }] });
    const jobs = await import('./src/forge/jobs.js');
    // Custom JS reward through the sandbox: shorter answers score higher.
    const { id } = await jobs.startRun({ method: 'grpo', base: ref, dataset: 'forge-test-grpo', maxSteps: 2, batch: 1, group: 3, maxNew: 12, lr: 1e-4, rank: 8, sampleTokens: 16, rewardCode: 'function reward(c, row) { return (c.includes(row.answer) ? 1 : 0) - c.length / 200; }' });
    const { run, live } = await waitRun(id);
    return { state: run.state, error: run.error, metrics: live.metrics, rollouts: live.rollouts.length, sample: live.rollouts[0]?.completions?.map(c => [c.text.slice(0, 40), c.reward]) };
  }, ref);
  log('grpo:', JSON.stringify(r).slice(0, 600));
  check('GRPO run finished with sandbox rewards', r.state === 'done' && r.rollouts >= 2 && r.metrics.every(m => Number.isFinite(m.reward)), r.error || '');
}

if (want('scratch')) {
  const r = await page.evaluate(async () => {
    const ds = await import('./src/studio/datasets.js'); const vfs = await import('./src/core/vfs.js');
    await vfs.rm('/datasets/forge-test-text').catch(() => {});
    const base = 'The cat sat on the mat. The dog sat on the log. The bird sat on the branch. ';
    const rows = Array.from({ length: 60 }, (_, i) => ({ text: (base + `Number ${i} is here. `).repeat(4) }));
    await ds.createDataset('forge-test-text', { type: 'text', rows });
    const jobs = await import('./src/forge/jobs.js');
    const { id } = await jobs.startRun({ method: 'pretrain', base: 'scratch', size: 'nano', vocabSize: 512, dataset: 'forge-test-text', maxSteps: 40, batch: 4, seqLen: 64, lr: 3e-3 });
    const { run, live } = await waitRun(id);
    let gguf = null, text = null;
    if (run.state === 'done') {
      gguf = await jobs.exportRun(id, 'gguf', { name: 'nano-test', ggufType: 'f16' });
      const reg = await import('./src/models/registry.js');
      await reg.refreshModels();
      const m = reg.modelsStore.get().local.find(x => x.id === 'nano-test-gguf');
      m.gpu = false;
      try { const res = await reg.chat(m.ref, { messages: [{ role: 'user', content: 'The cat sat' }], maxTokens: 12, temperature: 0 }); text = res.content.map(b => b.text || '').join(''); } catch (e) { text = 'error: ' + e.message; }
      await reg.unloadLocal();
    }
    return { state: run.state, error: run.error, first: live.metrics[0]?.loss, last: live.metrics.at(-1)?.loss, val: live.evals.at(-1)?.val_loss, sample: live.samples.at(-1)?.text, gguf, text };
  });
  log('scratch:', JSON.stringify(r).slice(0, 600));
  check('from-scratch run finished', r.state === 'done', r.error || '');
  check('from-scratch loss dropped', r.last < r.first * 0.5, `${r.first?.toFixed(3)} -> ${r.last?.toFixed(3)}`);
  check('from-scratch GGUF loads in llama.cpp', r.text != null && !String(r.text).startsWith('error'), String(r.text).slice(0, 80));
}

const errs = logs.filter(l => /pageerror|WebGPU error/.test(l));
if (errs.length) { console.log(errs.slice(0, 10).join('\n')); }
console.log(fails ? `${fails} failed` : 'all passed');
await browser.close(); stopServer();
process.exit(fails ? 1 : 0);
