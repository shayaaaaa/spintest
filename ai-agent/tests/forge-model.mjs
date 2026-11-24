// Checks the Forge transformer against a plain-JS reference: forward loss, KV-cache decoding, and gradients of every
// parameter tensor via central finite differences (full fine-tune and LoRA), for Llama (GQA, untied), Qwen2 (biases)
// and Qwen3 (QK-norm) shaped tiny models.
import { setup, openApp, DUO, stopServer } from './lib.mjs';

const { browser, base } = await setup({ port: 8097 });
const { page, logs } = await openApp(browser, base, { size: DUO.folded });
page.setDefaultTimeout(600000);
const results = await page.evaluate(async () => {
  const { GPU } = await import('./src/forge/gpu.js');
  const { LlamaModel, normalizeConfig } = await import('./src/forge/model.js');
  const { encodeSafetensors } = await import('./src/forge/safetensors.js');
  const { refForward, refLoss, tinyCheckpoint } = await import('./tests/ref-llama.js');
  const g = await GPU.create();
  const out = [];
  const rel = (a, b) => Math.abs(a - b) / Math.max(1e-6, Math.abs(b));
  const push = (name, err, tol) => out.push({ name, ok: Number.isFinite(err) && err < tol, err });
  let seed = 3;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());

  const meanLoss = async (m, ids, labels) => {
    const fw = m.forwardTrain(ids);
    const { lp } = await m.lossPass(fw.h, ids.length, labels, null);
    m.freeForward(fw);
    let s = 0, n = 0; for (let t = 0; t < ids.length; t++) if (labels[t] >= 0) { s -= lp[t]; n++; }
    return s / n;
  };
  const grads = async (m, ids, labels) => {
    const n = [...labels].filter(x => x >= 0).length;
    const coef = Float32Array.from(labels, l => l >= 0 ? 1 / n : 0);
    m.zeroGrad();
    const fw = m.forwardTrain(ids);
    const { dh } = await m.lossPass(fw.h, ids.length, labels, coef);
    m.backward(fw, dh);
    g.release(dh); m.freeForward(fw);
  };
  // Directional derivative check for one parameter tensor.
  const fdCheck = async (m, p, ids, labels, eps = 2e-3) => {
    const w0 = await g.readF32(p.buf, p.n), gr = await g.readF32(p.grad, p.n);
    const v = Float32Array.from({ length: p.n }, gauss);
    let analytic = 0; for (let i = 0; i < p.n; i++) analytic += gr[i] * v[i];
    const wp = Float32Array.from(w0, (x, i) => x + eps * v[i]), wm = Float32Array.from(w0, (x, i) => x - eps * v[i]);
    g.upload(p.buf, wp); const lp = await meanLoss(m, ids, labels);
    g.upload(p.buf, wm); const lm = await meanLoss(m, ids, labels);
    g.upload(p.buf, w0);
    const numeric = (lp - lm) / (2 * eps);
    return { analytic, numeric, err: Math.abs(analytic - numeric) / Math.max(1e-4, Math.abs(numeric), Math.abs(analytic)) };
  };

  for (const type of ['llama', 'qwen2', 'qwen3']) {
    const { config, W } = tinyCheckpoint(type);
    const file = new File([encodeSafetensors(Object.entries(W).map(([name, data]) => ({ name, dtype: 'F32', shape: [data.length], data })))], 'model.safetensors');
    const cfg = normalizeConfig(config);
    const T = 13;
    const ids = Array.from({ length: T }, () => Math.floor(rnd() * cfg.V));
    const labels = Int32Array.from({ length: T }, (_, t) => t < T - 1 ? ids[t + 1] : -1);
    const refCfg = { ...cfg, qkNorm: cfg.qkNorm };
    const refLogits = refForward(refCfg, W, ids);
    const refL = refLoss(refLogits, labels, cfg.V);

    // ---- full fine-tune (all f32) ----
    const m = new LlamaModel(g, { ...cfg }, { mode: 'full' });
    await m.loadWeights([file]);
    const loss = await meanLoss(m, ids, labels);
    push(`${type} full: forward loss (${loss.toFixed(5)} vs ${refL.toFixed(5)})`, rel(loss, refL), 1e-4);
    // KV-cache decoding: prefill 7 then 6 more one at a time; compare final logits with reference last row.
    m.allocCache(32); m.cache.pos = 0;
    await m.forwardInfer(ids.slice(0, 7));
    let lg; for (let t = 7; t < T; t++) lg = await m.forwardInfer([ids[t]]);
    const scaleRef = Math.max(...refLogits.subarray((T - 1) * cfg.V).map(Math.abs));
    let e = 0; for (let j = 0; j < cfg.V; j++) e = Math.max(e, Math.abs(lg[j] - refLogits[(T - 1) * cfg.V + j]) / scaleRef);
    push(`${type} full: KV-cache decode logits (max err / max |logit|)`, e, 1e-3);
    m.cache.pos = 0;
    const lg2 = await m.forwardInfer(ids);
    e = 0; for (let j = 0; j < cfg.V; j++) e = Math.max(e, Math.abs(lg2[j] - refLogits[(T - 1) * cfg.V + j]) / scaleRef);
    push(`${type} full: prefill logits (max err / max |logit|)`, e, 1e-3);
    await grads(m, ids, labels);
    for (const p of m.params) {
      let r = await fdCheck(m, p, ids, labels);
      if (r.err > 3e-2) { const r2 = await fdCheck(m, p, ids, labels, 5e-4); if (r2.err < r.err) r = r2; }
      push(`${type} full: grad ${p.name} (${r.analytic.toExponential(3)} vs ${r.numeric.toExponential(3)})`, r.err, 3e-2);
    }
    m.freeCache();

    // ---- LoRA on f16 frozen weights ----
    const ml = new LlamaModel(g, { ...cfg }, { mode: 'lora', lora: { r: 4, alpha: 8 } });
    await ml.loadWeights([file]);
    const l0 = await meanLoss(ml, ids, labels);
    push(`${type} lora/f16: forward loss before training`, rel(l0, refL), 5e-3);
    // Param IO round trip (names follow HF/PEFT).
    const st = await m.readParams();
    out.push({ name: `${type} full: readParams uses HF names`, ok: st.has('model.embed_tokens.weight') && st.has('model.layers.1.mlp.down_proj.weight') && st.get('model.embed_tokens.weight').data.length === cfg.V * cfg.D, err: 0 });
    // Give B non-zero values so A gets gradients too.
    for (const p of ml.params) if (p.name.includes('lora_B')) g.upload(p.buf, Float32Array.from({ length: p.n }, () => gauss() * 0.05));
    await grads(ml, ids, labels);
    const pick = ml.params.filter((p, i) => i % 3 === 0 || /layers\.0\.self_attn\.q|layers\.1\.mlp\.down/.test(p.name));
    for (const p of pick) {
      let r = await fdCheck(ml, p, ids, labels);
      if (r.err > 5e-2) { const r2 = await fdCheck(ml, p, ids, labels, 5e-4); if (r2.err < r.err) r = r2; }
      push(`${type} lora: grad ${p.name} (${r.analytic.toExponential(3)} vs ${r.numeric.toExponential(3)})`, r.err, 5e-2);
    }
    // A few optimizer steps should reduce the loss.
    let before = await meanLoss(ml, ids, labels), after = before;
    for (let s = 1; s <= 20; s++) { await grads(ml, ids, labels); const gn = await ml.gradNorm(); ml.step({ step: s, lr: 1e-2, gnorm: gn, clip: 1 }); }
    after = await meanLoss(ml, ids, labels);
    out.push({ name: `${type} lora: 20 AdamW steps reduce loss (${before.toFixed(3)} -> ${after.toFixed(3)})`, ok: after < before * 0.8, err: after / before });

    // ---- QLoRA (NF4) forward sanity ----
    const mq = new LlamaModel(g, { ...cfg }, { mode: 'lora', quant: 'nf4', lora: { r: 4 } });
    await mq.loadWeights([file]);
    const lq = await meanLoss(mq, ids, labels);
    push(`${type} qlora/nf4: forward loss close to f32 (${lq.toFixed(4)} vs ${refL.toFixed(4)})`, rel(lq, refL), 0.1);
  }
  return { out, err: g.lastError || null };
});
let fails = 0;
for (const r of results.out) { if (!r.ok) fails++; console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.name}  err=${typeof r.err === 'number' ? r.err.toExponential(2) : r.err}`); }
if (results.err) { console.log('GPU error:', results.err); fails++; }
const errs = logs.filter(l => l.includes('error') && !l.includes('favicon'));
if (errs.length) console.log(errs.slice(0, 10).join('\n'));
console.log(fails ? `${fails} failed` : 'all passed');
await browser.close(); stopServer();
process.exit(fails ? 1 : 0);
