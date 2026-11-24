// ForgeHost: owns the WebGPU device, the loaded model and training runs. Runs inside the forge worker (or on the main
// thread as a fallback). `emit(event)` streams progress; `call(name, args)` asks the main thread for things a worker
// cannot do (running user JavaScript reward functions in the sandbox).
import { GPU } from './gpu.js';
import * as ops from './ops.js';
import { LlamaModel, normalizeConfig } from './model.js';
import { Tok, StreamDecoder, trainBPE, CHATML_TEMPLATE } from './tokenizer.js';
import { readHeader, readTensor, writeSafetensors, toDtype } from './safetensors.js';
import * as D from './data.js';
import { scoreBuiltin, isBuiltin } from './rewards.js';
import { adapterConfig, writeGGUF, ggufTokenizer, PEFT_MODULES } from './export.js';
import * as vfs from '../core/vfs.js';

export const SCRATCH_SIZES = {
  nano: { hidden_size: 128, num_hidden_layers: 4, num_attention_heads: 4, num_key_value_heads: 2, intermediate_size: 384, vocab: 4096 },
  micro: { hidden_size: 256, num_hidden_layers: 6, num_attention_heads: 4, num_key_value_heads: 2, intermediate_size: 768, vocab: 8192 },
  small: { hidden_size: 512, num_hidden_layers: 8, num_attention_heads: 8, num_key_value_heads: 4, intermediate_size: 1536, vocab: 16384 },
  base: { hidden_size: 768, num_hidden_layers: 12, num_attention_heads: 12, num_key_value_heads: 4, intermediate_size: 2048, vocab: 32000 },
};
const TOKENIZER_FILES = ['tokenizer.json', 'tokenizer_config.json', 'special_tokens_map.json', 'chat_template.jinja', 'generation_config.json'];
const now = () => performance.now();

async function weightFiles(dir) {
  const idx = await vfs.readJSON(`${dir}/model.safetensors.index.json`, null);
  const names = idx ? [...new Set(Object.values(idx.weight_map))] : (await vfs.list(dir)).filter(e => e.name.endsWith('.safetensors')).map(e => e.name).sort();
  if (!names.length) throw new Error(`No .safetensors weights in ${dir}`);
  return Promise.all(names.map(n => vfs.getFile(`${dir}/${n}`)));
}

export class ForgeHost {
  constructor({ emit = () => {}, call = async () => { throw new Error('No main-thread bridge'); } } = {}) {
    this.emit = emit; this.call = call;
    this.g = null; this.cur = null; this.job = null; this.streams = new Map();
  }

  async gpu() {
    if (this.g?.lost) { this.g = null; this.cur = null; }
    return this.g ||= await GPU.create();
  }
  async info() {
    const g = await this.gpu();
    const a = g.adapter.info || {};
    return { vendor: a.vendor, architecture: a.architecture, description: a.description, maxBuffer: g.limits.maxBufferSize, maxBinding: g.maxBinding, busy: !!this.job, loaded: this.cur?.key || null };
  }

  // ---------- model loading ----------
  async openModel(dir, { mode = 'infer', quant = 'f16', lora = null, onProgress } = {}) {
    const g = await this.gpu();
    this.unload();
    const hf = await vfs.readJSON(`${dir}/config.json`, null);
    if (!hf) throw new Error(`${dir} has no config.json`);
    const cfg = normalizeConfig(hf);
    const files = await weightFiles(dir);
    const m = new LlamaModel(g, cfg, { mode, quant, lora: lora || undefined });
    if (mode !== 'lora') m.lora = null;
    try { await m.loadWeights(files, onProgress); } catch (e) { m.free(); throw e; }
    const tok = await Tok.fromDir(dir);
    return { m, tok, hf, cfg, files, dir };
  }

  unloadIfIdle() { if (!this.job) this.unload(); }
  unload() {
    if (this.cur && this.job && this.cur === this.job.model) throw new Error('A training run is using the GPU. Stop it first.');
    if (this.cur) { this.cur.m.free(); this.cur = null; }
  }

  // Loads a model for chat. adapterDir: PEFT adapter trained on this base.
  async load({ dir, adapterDir = null, key }) {
    key ||= dir + (adapterDir ? '+' + adapterDir : '');
    if (this.cur?.key === key) return { key, ...this.describe() };
    if (this.job) throw new Error('A training run is using the GPU. Wait for it to finish or stop it.');
    const onProgress = (p) => this.emit({ type: 'load', ...p });
    let lora = null;
    if (adapterDir) { const ac = await vfs.readJSON(`${adapterDir}/adapter_config.json`); lora = { r: ac.r, alpha: ac.lora_alpha, targets: Object.entries(PEFT_MODULES).filter(([, v]) => ac.target_modules.includes(v)).map(([k]) => k) }; }
    const cur = await this.openModel(dir, { mode: adapterDir ? 'lora' : 'infer', lora, onProgress });
    if (adapterDir) await this.loadTensorsInto(cur.m, `${adapterDir}/adapter_model.safetensors`);
    this.cur = { ...cur, key };
    return { key, ...this.describe() };
  }
  describe() { const c = this.cur?.cfg; return c ? { type: c.type, layers: c.L, hidden: c.D, vocab: c.V, context: c.maxPos } : {}; }

  async loadTensorsInto(m, path, which = 'buf', prefix = '') {
    const f = await vfs.getFile(path);
    const h = await readHeader(f);
    let n = 0;
    for (const spec of m.paramSpecs()) {
      const info = h.tensors[prefix + spec.name];
      if (!info) continue;
      m.writeParam(spec, await readTensor(f, info, h.dataStart), which); n++;
    }
    return n;
  }

  // ---------- generation ----------
  // req: {prompt} (pre-rendered text) or {messages, tools, thinking}; streams {type:'token', stream, text}.
  async generate(req, stream) {
    if (!this.cur) throw new Error('No Forge model loaded');
    if (this.job && !req.allowDuringTraining) throw new Error('A training run is using the GPU right now.');
    const { m, tok } = this.cur;
    const text = req.prompt ?? tok.chat(req.messages, { addGenerationPrompt: true, tools: req.tools, thinking: req.thinking });
    const ids = tok.encode(text);
    const ac = new AbortController();
    if (stream) this.streams.set(stream, ac);
    const dec = new StreamDecoder(tok);
    const stopStrings = req.stop || [];
    let out = '', stopped = null;
    const t0 = now(); let tFirst = 0;
    try {
      const gen = await m.generate(ids, {
        maxNew: req.maxTokens ?? 512, temperature: req.temperature ?? 0.7, topP: req.topP ?? 0.9, topK: req.topK ?? 50, repetitionPenalty: req.repetitionPenalty ?? 1.05,
        stop: [...tok.eos], signal: ac.signal,
        onToken: (id) => {
          if (!tFirst) tFirst = now();
          const d = dec.push(id);
          if (!d) return;
          out += d;
          for (const s of stopStrings) { const i = out.indexOf(s); if (i >= 0) { out = out.slice(0, i); stopped = s; return false; } }
          if (stream) this.emit({ type: 'token', stream, text: d });
        },
      });
      const ms = now() - t0;
      return { text: out, usage: { input: ids.length, output: gen.length, tps: gen.length > 1 ? (gen.length - 1) / ((now() - tFirst) / 1000) : 0, prefill: m.lastPrefill, ms }, finish: stopped ? 'stop' : m.stopped != null && gen.length < (req.maxTokens ?? 512) ? 'stop' : 'length', aborted: ac.signal.aborted };
    } finally { this.streams.delete(stream); m.stopped = null; }
  }
  abort(stream) { this.streams.get(stream)?.abort(); }

  // ---------- evaluation ----------
  async evaluate({ rows, maxRows = 64, seqLen = 1024 }) {
    if (!this.cur) throw new Error('No Forge model loaded');
    const { m, tok } = this.cur;
    const { examples } = D.sftExamples(tok, rows.slice(0, maxRows), { seqLen });
    let nll = 0, n = 0;
    const t0 = now();
    for (const ex of examples) {
      const fw = m.forwardTrain(ex.ids);
      const { lp } = await m.lossPass(fw.h, ex.ids.length, ex.labels, null);
      m.freeForward(fw);
      for (let t = 0; t < ex.labels.length; t++) if (ex.labels[t] >= 0) { nll -= lp[t]; n++; }
    }
    const loss = n ? nll / n : NaN;
    return { loss, perplexity: Math.exp(loss), tokens: n, examples: examples.length, ms: now() - t0 };
  }

  async benchmark() {
    const g = await this.gpu();
    const M = 512, N = 2048, K = 2048;
    const A = g.buffer(M * K * 4), B = g.buffer(N * K * 4), C = g.buffer(M * N * 4);
    ops.fill(g, A, M * K, 0.01); ops.fill(g, B, N * K, 0.01);
    await g.sync();
    const W = { buf: B, dtype: 'f32', out: N, in: K };
    ops.linear(g, A, W, C, M); await g.sync();
    const reps = 4, t0 = now();
    for (let i = 0; i < reps; i++) ops.linear(g, A, W, C, M);
    await g.sync();
    const s = (now() - t0) / 1000;
    g.free(A); g.free(B); g.free(C);
    return { gflops: (2 * M * N * K * reps) / s / 1e9 };
  }

  // ---------- training ----------
  stop(id, { pause = false } = {}) { if (this.job && (!id || this.job.id === id)) this.job.stop = pause ? 'paused' : 'stopped'; }

  async train(c) {
    if (this.job) throw new Error('Another training run is active.');
    const job = this.job = { id: c.id, stop: null, model: null };
    const emit = (e) => this.emit({ run: c.id, ...e });
    const status = (state, text, extra = {}) => emit({ type: 'status', state, text, ...extra });
    const runDir = c.runDir;
    let metricsBuf = [];
    const flushMetrics = async () => { if (!metricsBuf.length) return; const lines = metricsBuf.join(''); metricsBuf = []; await vfs.append(`${runDir}/metrics.jsonl`, lines); };
    try {
      status('preparing', 'Loading model…');
      this.unload();
      const g = await this.gpu();
      const tuning = c.method === 'scratch' ? 'full' : (c.tuning || 'lora');
      const loraCfg = { r: c.rank || 16, alpha: c.alpha || 2 * (c.rank || 16), targets: c.targets || ['q', 'k', 'v', 'o', 'gate', 'up', 'down'] };
      const ckpt = await latestCheckpoint(runDir);
      const resumeState = c.resume && ckpt ? await vfs.readJSON(`${ckpt}/state.json`, null) : null;
      let cur;
      if (c.method === 'scratch') {
        const modelDir = `${runDir}/model`;
        let tok;
        if (await vfs.exists(`${modelDir}/tokenizer.json`)) tok = await Tok.fromDir(modelDir);
        else {
          status('preparing', 'Training tokenizer…');
          const texts = (function* () { for (const r of c.rows) { const n = D.normalizeRow(r); if (n?.text) yield n.text; else if (n?.messages) yield n.messages.map(x => x.content).join('\n'); } })();
          const size = SCRATCH_SIZES[c.size || 'micro'];
          const t = await trainBPE(texts, { vocabSize: c.vocabSize || size.vocab, onProgress: (p) => status('preparing', `Training tokenizer… ${Math.round(p * 100)}%`) });
          await vfs.writeJSON(`${modelDir}/tokenizer.json`, t.tokenizerJson);
          await vfs.writeJSON(`${modelDir}/tokenizer_config.json`, t.tokenizerConfig);
          tok = await Tok.fromFiles({ tokenizerJson: t.tokenizerJson, tokenizerConfig: t.tokenizerConfig });
        }
        let hf = await vfs.readJSON(`${modelDir}/config.json`, null);
        if (!hf) {
          const s = SCRATCH_SIZES[c.size || 'micro'];
          const pad = Math.ceil(tok.size() / 64) * 64;
          hf = { architectures: ['LlamaForCausalLM'], model_type: 'llama', hidden_size: s.hidden_size, num_hidden_layers: s.num_hidden_layers, num_attention_heads: s.num_attention_heads, num_key_value_heads: s.num_key_value_heads, intermediate_size: s.intermediate_size, vocab_size: pad, max_position_embeddings: Math.max(2048, c.seqLen || 512), rms_norm_eps: 1e-5, rope_theta: 10000, tie_word_embeddings: true, hidden_act: 'silu', bos_token_id: null, eos_token_id: tok.tokenId('<|im_end|>'), pad_token_id: tok.tokenId('<|pad|>'), torch_dtype: 'float32', attention_bias: false, mlp_bias: false };
          await vfs.writeJSON(`${modelDir}/config.json`, hf);
          await vfs.writeJSON(`${modelDir}/generation_config.json`, { eos_token_id: [tok.tokenId('<|im_end|>'), tok.tokenId('<|endoftext|>')].filter(x => x != null) });
        }
        tok = await Tok.fromDir(modelDir);
        const cfg = normalizeConfig(hf);
        const m = new LlamaModel(g, cfg, { mode: 'full' });
        m.lora = null;
        await m.initRandom(c.seed || 1);
        cur = { m, tok, hf, cfg, files: [], dir: modelDir };
      } else {
        cur = await this.openModel(c.baseDir, { mode: tuning === 'full' ? 'full' : 'lora', quant: tuning === 'qlora' ? 'nf4' : 'f16', lora: loraCfg, onProgress: (p) => status('preparing', p.text, { progress: p.progress }) });
      }
      const { m, tok } = cur;
      this.cur = { ...cur, key: 'run:' + c.id };
      job.model = this.cur;
      if (resumeState) {
        status('preparing', 'Restoring checkpoint…');
        await this.loadTensorsInto(m, `${ckpt}/trainable.safetensors`);
        if (await vfs.exists(`${ckpt}/optimizer.safetensors`)) { await this.loadTensorsInto(m, `${ckpt}/optimizer.safetensors`, 'm', 'm.'); await this.loadTensorsInto(m, `${ckpt}/optimizer.safetensors`, 'v', 'v.'); }
      }

      // ---- data ----
      status('preparing', 'Tokenizing dataset…');
      const seqLen = c.seqLen || (c.method === 'scratch' || c.method === 'pretrain' ? 512 : 1024);
      let examples, val = [];
      const isLM = c.method === 'sft' || c.method === 'pretrain' || c.method === 'scratch';
      if (c.method === 'sft') { examples = D.sftExamples(tok, c.rows, { seqLen, completionOnly: c.completionOnly !== false, thinking: c.thinking }).examples; if (c.valRows?.length) val = D.sftExamples(tok, c.valRows, { seqLen }).examples.slice(0, 32); }
      else if (c.method === 'pretrain' || c.method === 'scratch') { examples = D.textBlocks(tok, c.rows, { seqLen }).examples; if (c.valRows?.length) val = D.textBlocks(tok, c.valRows, { seqLen }).examples.slice(0, 32); }
      else if (c.method === 'dpo') examples = D.dpoExamples(tok, c.rows, { seqLen, thinking: c.thinking }).examples;
      else if (c.method === 'grpo') examples = D.grpoPrompts(tok, c.rows, { maxPrompt: Math.max(64, seqLen - (c.maxNew || 256)), thinking: c.thinking });
      else throw new Error('Unknown method ' + c.method);
      if (!examples.length) throw new Error('The dataset produced no usable training examples. Check its format in Studio → Datasets.');
      if (isLM && !val.length && examples.length >= 20 && c.holdout !== false) val = examples.splice(examples.length - Math.max(1, Math.min(32, Math.floor(examples.length * 0.05)))).slice(0, 32);

      const batch = Math.max(1, c.batch || (c.method === 'grpo' ? 1 : 8));
      const epochs = c.epochs ?? 1;
      const stepsPerEpoch = Math.max(1, Math.ceil(examples.length / batch));
      const total = Math.max(1, c.maxSteps || Math.ceil(stepsPerEpoch * epochs));
      const lr0 = c.lr || (tuning === 'full' ? (c.method === 'scratch' ? 1e-3 : 2e-5) : 2e-4);
      const warm = c.warmup ?? Math.max(1, Math.round(total * 0.05));
      const minRatio = c.minLrRatio ?? 0.1;
      const lrAt = (s) => s <= warm ? lr0 * s / warm : lr0 * (minRatio + (1 - minRatio) * 0.5 * (1 + Math.cos(Math.PI * Math.min(1, (s - warm) / Math.max(1, total - warm)))));
      const saveEvery = c.saveEvery || Math.max(10, Math.min(200, Math.round(total / 10)));
      const evalEvery = c.evalEvery || Math.max(10, Math.min(100, Math.round(total / 10)));
      const seed = c.seed || 1;
      let step = resumeState?.step || 0, tokensSeen = resumeState?.tokens || 0;
      const orderFor = (ep) => D.shuffled(examples.length, seed + ep * 7919);
      let ep = Math.floor((step * batch) / examples.length), order = orderFor(ep);
      const take = () => { const out = []; for (let i = 0; i < batch; i++) { const k = (step * batch + i); const e = Math.floor(k / examples.length); if (e !== ep) { ep = e; order = orderFor(ep); } out.push(examples[order[k % examples.length]]); } return out; };

      // DPO reference log-probs: computed once with adapters off (or before any update for full fine-tunes).
      if (c.method === 'dpo') {
        const refPath = `${runDir}/ref_logps.json`;
        let refs = await vfs.readJSON(refPath, null);
        if (!refs || refs.length !== examples.length) {
          refs = [];
          const prev = m.loraOn; m.loraOn = false;
          if (tuning === 'full' && resumeState) throw new Error('Reference log-probs are missing for this resumed full DPO run.');
          for (let i = 0; i < examples.length; i++) {
            if (job.stop) break;
            refs.push([await this.seqLogp(m, examples[i].chosen), await this.seqLogp(m, examples[i].rejected)]);
            if (i % 8 === 0) status('preparing', `Reference pass ${i + 1}/${examples.length}`, { progress: (i + 1) / examples.length });
          }
          m.loraOn = prev;
          await vfs.writeJSON(refPath, refs);
        }
        examples.forEach((e, i) => { e.ref = refs[i]; });
      }

      const samplePrompts = (c.samplePrompts?.length ? c.samplePrompts : (c.method === 'grpo' ? examples.slice(0, 2).map(e => tok.decode(e.ids)) : this.pickSamplePrompts(c, tok))).slice(0, 2);
      await vfs.writeJSON(`${runDir}/plan.json`, { total, stepsPerEpoch, examples: examples.length, val: val.length, batch, lr: lr0, warm, saveEvery, evalEvery, trainable: m.numTrainable(), tuning, seqLen });
      status('training', resumeState ? `Resumed at step ${step}` : 'Training', { total, step, examples: examples.length, trainable: m.numTrainable() });
      const tStart = now();
      let lastSave = step;

      while (step < total) {
        if (job.stop) break;
        if (g.lost) throw new Error('The GPU device was lost (memory pressure or the app went to the background). Resume from the last checkpoint.');
        const t0 = now();
        const group = take();
        let r;
        if (isLM) r = await this.stepLM(m, group);
        else if (c.method === 'dpo') r = await this.stepDPO(m, group, c.beta ?? 0.1);
        else r = await this.stepGRPO(m, tok, group, c, emit, step);
        const gnorm = await m.gradNorm();
        if (!Number.isFinite(gnorm) || !Number.isFinite(r.loss)) { m.zeroGrad(); emit({ type: 'warn', text: `Step ${step + 1}: non-finite loss/gradient, skipped.` }); step++; continue; }
        step++;
        const lr = lrAt(step);
        m.step({ step, lr, wd: c.wd ?? (tuning === 'full' ? 0.01 : 0), clip: c.clip ?? 1, gnorm });
        tokensSeen += r.tokens;
        const ms = now() - t0;
        const metric = { step, loss: r.loss, lr, gnorm, tokens: r.tokens, tps: r.tokens / (ms / 1000), ms: Math.round(ms), epoch: (step * batch) / examples.length, t: Date.now(), ...r.extra };
        metricsBuf.push(JSON.stringify(metric) + '\n');
        emit({ type: 'metric', ...metric, total, eta: ((now() - tStart) / Math.max(1, step - (resumeState?.step || 0))) * (total - step) / 1000 });
        if (step % evalEvery === 0 || step === total) {
          if (val.length) { const vl = await this.valLoss(m, val); const vm = { step, val_loss: vl, t: Date.now() }; metricsBuf.push(JSON.stringify(vm) + '\n'); emit({ type: 'eval', ...vm }); }
          for (const p of samplePrompts) {
            const ids = tok.encode(p);
            const out = await m.generate(ids, { maxNew: c.sampleTokens || 96, temperature: 0.7, stop: [...tok.eos] });
            const s = { step, prompt: p.slice(-300), text: tok.decode(out, { skipSpecial: true }) };
            emit({ type: 'sample', ...s });
            await vfs.append(`${runDir}/samples.jsonl`, JSON.stringify(s) + '\n');
          }
          await flushMetrics();
        }
        if (step - lastSave >= saveEvery && step < total) { await flushMetrics(); await this.saveCheckpoint(m, runDir, { step, tokens: tokensSeen }, c.saveOptimizer !== false, status); lastSave = step; status('training', 'Training', { total, step }); }
        if (step % 20 === 0) await flushMetrics();
      }
      await flushMetrics();
      await this.saveCheckpoint(m, runDir, { step, tokens: tokensSeen, done: step >= total }, c.saveOptimizer !== false && step < total, status);
      const final = job.stop || 'done';
      status(final, final === 'done' ? `Finished ${step} steps` : `${final === 'paused' ? 'Paused' : 'Stopped'} at step ${step} (checkpoint saved)`, { step, total });
      return { state: final, step, total };
    } catch (e) {
      try { await flushMetrics(); } catch {}
      status('error', String(e.message || e));
      throw e;
    } finally {
      this.job = null;
    }
  }

  pickSamplePrompts(c, tok) {
    const out = [];
    for (const r of [...(c.valRows || []), ...c.rows]) {
      const n = D.normalizeRow(r);
      if (n?.messages) { const i = n.messages.findIndex(x => x.role === 'assistant'); if (i > 0) out.push(tok.chat(n.messages.slice(0, i), { addGenerationPrompt: true, thinking: c.thinking })); }
      else if (n?.text) out.push(n.text.slice(0, 64));
      if (out.length >= 2) break;
    }
    return out;
  }

  async seqLogp(m, ex) {
    const fw = m.forwardTrain(ex.ids);
    const { lp } = await m.lossPass(fw.h, ex.ids.length, ex.labels, null);
    m.freeForward(fw);
    let s = 0; for (let t = 0; t < lp.length; t++) if (ex.labels[t] >= 0) s += lp[t];
    return s;
  }

  async valLoss(m, val) {
    let nll = 0, n = 0;
    for (const ex of val) {
      const fw = m.forwardTrain(ex.ids);
      const { lp } = await m.lossPass(fw.h, ex.ids.length, ex.labels, null);
      m.freeForward(fw);
      for (let t = 0; t < lp.length; t++) if (ex.labels[t] >= 0) { nll -= lp[t]; n++; }
    }
    return n ? nll / n : NaN;
  }

  // Token-averaged next-token loss over the group (SFT, continued pretraining, from scratch).
  async stepLM(m, group) {
    const g = m.g;
    let ntok = 0, tokens = 0;
    for (const ex of group) { tokens += ex.ids.length; for (const l of ex.labels) if (l >= 0) ntok++; }
    let nll = 0;
    for (const ex of group) {
      const coef = Float32Array.from(ex.labels, l => l >= 0 ? 1 / ntok : 0);
      const fw = m.forwardTrain(ex.ids);
      const { lp, dh } = await m.lossPass(fw.h, ex.ids.length, ex.labels, coef);
      m.backward(fw, dh);
      g.release(dh); m.freeForward(fw);
      for (let t = 0; t < lp.length; t++) if (ex.labels[t] >= 0) nll -= lp[t];
    }
    return { loss: nll / ntok, tokens };
  }

  // DPO: L = -log σ(β[(πc - rc) - (πr - rr)]); per-token coefficient = -dL/dlogp.
  async stepDPO(m, group, beta) {
    const g = m.g;
    let loss = 0, acc = 0, margin = 0, tokens = 0;
    for (const ex of group) {
      const fws = [], lps = [];
      for (const s of [ex.chosen, ex.rejected]) {
        const fw = m.forwardTrain(s.ids);
        const { lp } = await m.lossPass(fw.h, s.ids.length, s.labels, null);
        let sum = 0; for (let t = 0; t < lp.length; t++) if (s.labels[t] >= 0) sum += lp[t];
        fws.push(fw); lps.push(sum); tokens += s.ids.length;
      }
      const z = beta * ((lps[0] - ex.ref[0]) - (lps[1] - ex.ref[1]));
      const sig = 1 / (1 + Math.exp(z)); // σ(-z)
      loss += Math.log1p(Math.exp(-Math.abs(z))) + Math.max(0, -z);
      acc += z > 0 ? 1 : 0; margin += z / beta;
      const w = [beta * sig / group.length, -beta * sig / group.length];
      for (let k = 0; k < 2; k++) {
        const s = k ? ex.rejected : ex.chosen;
        const coef = Float32Array.from(s.labels, l => l >= 0 ? w[k] : 0);
        const { dh } = await m.lossPass(fws[k].h, s.ids.length, s.labels, coef);
        m.backward(fws[k], dh);
        g.release(dh); m.freeForward(fws[k]);
      }
    }
    return { loss: loss / group.length, tokens, extra: { reward_acc: acc / group.length, reward_margin: margin / group.length } };
  }

  async rewards(c, texts, row) {
    if (c.rewardCode) return this.call('reward', { code: c.rewardCode, completions: texts, row });
    if (!isBuiltin(c.reward || 'exact')) throw new Error(`Unknown reward "${c.reward}"`);
    return scoreBuiltin(c.reward || 'exact', texts, row, c.rewardConfig || {});
  }

  // GRPO with group-relative advantages; per-token coefficient = (A_i - β(1 - e^{ref-p})) / |o_i| / (G·B).
  async stepGRPO(m, tok, group, c, emit, step) {
    const g = m.g;
    const G = Math.max(2, c.group || 4), beta = c.beta ?? (m.lora ? 0.04 : 0), maxNew = c.maxNew || 256;
    let tokens = 0, rewardSum = 0, rewardCount = 0, klSum = 0, klN = 0, lenSum = 0, objective = 0;
    for (const p of group) {
      const comps = [];
      for (let i = 0; i < G; i++) {
        const out = await m.generate(p.ids, { maxNew, temperature: c.temperature ?? 0.9, topP: 1, topK: 0, repetitionPenalty: 1, stop: [...tok.eos] });
        const ended = m.stopped != null; m.stopped = null;
        comps.push({ ids: ended ? [...out, [...tok.eos][0]] : out, text: tok.decode(out, { skipSpecial: true }) });
      }
      const rs = (await this.rewards(c, comps.map(x => x.text), p.row)).map(Number);
      const mean = rs.reduce((a, b) => a + b, 0) / G;
      const std = Math.sqrt(rs.reduce((a, b) => a + (b - mean) ** 2, 0) / G);
      rewardSum += rs.reduce((a, b) => a + b, 0); rewardCount += G;
      emit({ type: 'rollout', step: step + 1, prompt: tok.decode(p.ids, { skipSpecial: true }).slice(-200), completions: comps.map((x, i) => ({ text: x.text.slice(0, 600), reward: rs[i] })) });
      for (let i = 0; i < G; i++) {
        const A = std > 1e-6 ? (rs[i] - mean) / (std + 1e-4) : 0;
        const o = comps[i].ids;
        lenSum += o.length;
        if (!o.length || (A === 0 && beta === 0)) continue;
        const ids = [...p.ids, ...o];
        const P = p.ids.length;
        const labels = new Int32Array(ids.length).fill(-1);
        for (let t = P - 1; t < ids.length - 1; t++) labels[t] = ids[t + 1];
        const T = ids.length;
        tokens += T;
        let ref = null;
        if (beta > 0 && m.lora) {
          m.loraOn = false;
          const fr = m.forwardTrain(ids);
          ref = (await m.lossPass(fr.h, T, labels, null)).lp;
          m.freeForward(fr);
          m.loraOn = true;
        }
        const fw = m.forwardTrain(ids);
        const scale = 1 / o.length / (G * group.length);
        let coef;
        if (ref) {
          const { lp } = await m.lossPass(fw.h, T, labels, null);
          coef = new Float32Array(T);
          for (let t = 0; t < T; t++) if (labels[t] >= 0) { const d = ref[t] - lp[t]; const kl = Math.exp(d) - d - 1; klSum += kl; klN++; coef[t] = (A - beta * (1 - Math.exp(d))) * scale; objective += A * lp[t] * scale; }
        } else coef = Float32Array.from(labels, l => l >= 0 ? A * scale : 0);
        const { lp, dh } = await m.lossPass(fw.h, T, labels, coef);
        if (!ref) for (let t = 0; t < T; t++) if (labels[t] >= 0) objective += A * lp[t] * scale;
        m.backward(fw, dh);
        g.release(dh); m.freeForward(fw);
      }
    }
    return { loss: -objective, tokens, extra: { reward: rewardSum / Math.max(1, rewardCount), kl: klN ? klSum / klN : 0, completion_len: lenSum / Math.max(1, group.length * G) } };
  }

  async saveCheckpoint(m, runDir, state, withOptimizer, status) {
    status?.('saving', `Saving checkpoint (step ${state.step})…`);
    // Each checkpoint gets its own folder; checkpoint.json points at the latest complete one.
    const prev = await latestCheckpoint(runDir);
    const tmp = `${runDir}/checkpoints/step-${state.step}`;
    if (tmp === prev) return;
    await vfs.rm(tmp, { silent: true }).catch(() => {});
    const specs = m.paramSpecs();
    const write = async (path, which, prefix) => {
      const ws = await vfs.createWriteStream(path);
      try { await writeSafetensors(ws, specs.map(s => ({ name: prefix + s.name, dtype: 'F32', shape: s.shape })), async (name) => m.readParam(specs.find(s => prefix + s.name === name), which), { format: 'pt' }); await ws.close(); }
      catch (e) { await ws.abort(); throw e; }
    };
    await write(`${tmp}/trainable.safetensors`, 'buf', '');
    if (withOptimizer) {
      const ws = await vfs.createWriteStream(`${tmp}/optimizer.safetensors`);
      const all = [...specs.map(s => ({ name: 'm.' + s.name, dtype: 'F32', shape: s.shape, s, w: 'm' })), ...specs.map(s => ({ name: 'v.' + s.name, dtype: 'F32', shape: s.shape, s, w: 'v' }))];
      try { await writeSafetensors(ws, all, async (name) => { const e = all.find(x => x.name === name); return m.readParam(e.s, e.w); }); await ws.close(); }
      catch (e) { await ws.abort(); throw e; }
    }
    await vfs.writeJSON(`${tmp}/state.json`, { ...state, saved: Date.now(), mode: m.mode, lora: m.lora });
    await vfs.writeJSON(`${runDir}/checkpoint.json`, { dir: tmp, step: state.step, saved: Date.now() });
    if (prev && prev !== tmp) await vfs.rm(prev, { silent: true }).catch(() => {});
  }

  // ---------- export ----------
  // Ensures the run's trained model is loaded (base + checkpoint) and returns it.
  async runModel(run) {
    if (this.cur?.key === 'run:' + run.id) return this.cur;
    if (this.job) throw new Error('A training run is active.');
    const ckpt = await latestCheckpoint(run.dir);
    const st = ckpt && await vfs.readJSON(`${ckpt}/state.json`, null);
    if (!st) throw new Error('This run has no checkpoint yet.');
    let cur;
    if (run.method === 'scratch') {
      const g = await this.gpu();
      this.unload();
      const dir = `${run.dir}/model`;
      const hf = await vfs.readJSON(`${dir}/config.json`);
      const cfg = normalizeConfig(hf);
      const m = new LlamaModel(g, cfg, { mode: 'full' }); m.lora = null;
      await m.initRandom(1);
      cur = { m, tok: await Tok.fromDir(dir), hf, cfg, files: [], dir };
    } else cur = await this.openModel(run.baseDir, { mode: st.mode === 'full' ? 'full' : 'lora', quant: 'f16', lora: st.lora || undefined });
    await this.loadTensorsInto(cur.m, `${ckpt}/trainable.safetensors`);
    this.cur = { ...cur, key: 'run:' + run.id };
    return this.cur;
  }

  // Specs and merged values for every tensor of the trained model, in HF names.
  async mergedSource(cur) {
    const { m, cfg } = cur;
    const g = m.g;
    const where = new Map();
    for (const f of cur.files) { const h = await readHeader(f); for (const [k, info] of Object.entries(h.tensors)) where.set(k, { f, info, ds: h.dataStart }); }
    const trainable = new Map(m.paramSpecs().filter(s => s.kind !== 'lora').map(s => [s.name, s]));
    const lin = new Map();
    for (const L of m.layers) for (const k of ['q', 'k', 'v', 'o', 'gate', 'up', 'down']) if (L[k]?.lora) lin.set(L[k].key + '.weight', L[k]);
    const specs = [];
    const seen = new Set();
    const order = ['model.embed_tokens.weight'];
    for (let i = 0; i < cfg.L; i++) for (const n of ['input_layernorm.weight', 'self_attn.q_proj.weight', 'self_attn.q_proj.bias', 'self_attn.k_proj.weight', 'self_attn.k_proj.bias', 'self_attn.v_proj.weight', 'self_attn.v_proj.bias', 'self_attn.o_proj.weight', 'self_attn.q_norm.weight', 'self_attn.k_norm.weight', 'post_attention_layernorm.weight', 'mlp.gate_proj.weight', 'mlp.up_proj.weight', 'mlp.down_proj.weight']) order.push(`model.layers.${i}.${n}`);
    order.push('model.norm.weight', 'lm_head.weight');
    for (const name of order) {
      const t = trainable.get(name) || where.get(name);
      if (!t) continue;
      if (name === 'lm_head.weight' && cfg.tied) continue;
      specs.push({ name, shape: trainable.get(name)?.shape || where.get(name).info.shape });
      seen.add(name);
    }
    const get = async (name) => {
      if (trainable.has(name)) return m.readParam(trainable.get(name));
      const w = where.get(name);
      const base = await readTensor(w.f, w.info, w.ds);
      const L = lin.get(name);
      if (!L || !m.loraOn) return base;
      const { r, scale, A, B } = L.lora;
      const delta = g.temp(L.out * L.in * 4);
      ops.matmul(g, { A: B.buf, B: A.buf, C: delta, M: L.out, N: L.in, Kd: r, sAm: r, sAk: 1, sBk: L.in, sBn: 1, sCm: L.in, alpha: scale });
      const d = await g.readF32(delta, L.out * L.in);
      g.release(delta);
      for (let i = 0; i < base.length; i++) base[i] += d[i];
      return base;
    };
    return { specs, get };
  }

  async copyTokenizer(fromDir, toDir) {
    for (const f of TOKENIZER_FILES) { const p = `${fromDir}/${f}`; if (await vfs.exists(p)) await vfs.write(`${toDir}/${f}`, await vfs.readBytes(p)); }
  }

  // what: 'adapter' | 'merged' | 'gguf'. Returns {dir, files}.
  async exportRun({ run, what, name, ggufType = 'q8_0', dtype = 'BF16' }) {
    const cur = await this.runModel(run);
    const { m, cfg, hf, tok } = cur;
    const st = (t, p) => this.emit({ type: 'export', run: run.id, what, text: t, progress: p });
    const safe = String(name || `${run.name || run.id}`).replace(/[^\w.-]+/g, '-');
    if (what === 'adapter') {
      if (!m.lora) throw new Error('This run trained all weights; export a merged model instead.');
      const dir = `/models/adapters/${safe}`;
      const specs = m.paramSpecs().filter(s => s.kind === 'lora');
      const ws = await vfs.createWriteStream(`${dir}/adapter_model.safetensors`);
      await writeSafetensors(ws, specs.map(s => ({ name: s.name, dtype: 'F32', shape: s.shape })), (n) => m.readParam(specs.find(s => s.name === n)), { format: 'pt' });
      await ws.close();
      await vfs.writeJSON(`${dir}/adapter_config.json`, adapterConfig({ ...m.lora, base: run.baseRepo || run.baseDir }));
      await vfs.write(`${dir}/README.md`, `# ${safe}\n\nLoRA adapter (r=${m.lora.r}, alpha=${m.lora.alpha}) trained in Ai Agent Studio with ${run.method.toUpperCase()} on \`${run.dataset}\`.\n\nBase model: \`${run.baseRepo || run.baseDir}\`\n\nLoad with PEFT: \`PeftModel.from_pretrained(base, "<this folder>")\`.\n`);
      await vfs.writeJSON(`${dir}/manifest.json`, { id: safe, name: safe, kind: 'adapters', engine: 'forge-adapter', base: run.baseDir, baseRef: run.baseRef, run: run.id, added: Date.now(), status: 'ready' });
      st('Done', 1);
      return { dir };
    }
    const src = await this.mergedSource(cur);
    if (what === 'merged') {
      const dir = `/models/llm/${safe}`;
      const ws = await vfs.createWriteStream(`${dir}/model.safetensors`);
      let i = 0;
      await writeSafetensors(ws, src.specs.map(s => ({ ...s, dtype })), async (n) => { st(`Writing ${n}`, ++i / src.specs.length); return toDtype(await src.get(n), dtype); }, { format: 'pt' });
      await ws.close();
      await vfs.writeJSON(`${dir}/config.json`, { ...hf, torch_dtype: dtype === 'F32' ? 'float32' : dtype === 'F16' ? 'float16' : 'bfloat16', tie_word_embeddings: cfg.tied });
      await this.copyTokenizer(cur.dir, dir);
      const bytes = (await vfs.stat(`${dir}/model.safetensors`)).size;
      await vfs.writeJSON(`${dir}/manifest.json`, { id: safe, name: safe, kind: 'llm', engine: 'forge', trainable: true, params: fmtParams(src.specs), context: Math.min(cfg.maxPos, 8192), bytes, source: { run: run.id, base: run.baseRepo || run.baseDir || 'scratch' }, forge: { format: 'safetensors' }, added: Date.now(), status: 'ready' });
      st('Done', 1);
      return { dir };
    }
    if (what === 'gguf') {
      const dir = `/models/llm/${safe}-gguf`;
      const file = `${safe}-${ggufType}.gguf`;
      const tcfg = { ...(await vfs.readJSON(`${cur.dir}/tokenizer_config.json`, {})) };
      const jinja = await vfs.readText(`${cur.dir}/chat_template.jinja`).catch(() => null);
      if (jinja) tcfg.chat_template = jinja;
      if (!tcfg.chat_template) tcfg.chat_template = CHATML_TEMPLATE;
      const genCfg = await vfs.readJSON(`${cur.dir}/generation_config.json`, {});
      const tokMeta = ggufTokenizer(tok.json, tcfg, hf, genCfg, cfg.V, cfg);
      const ws = await vfs.createWriteStream(`${dir}/${file}`);
      try { await writeGGUF(ws, { cfg, hfCfg: hf, tokenizer: tokMeta, specs: src.specs, get: src.get, ftype: ggufType, name: safe, onProgress: (p) => st('Writing GGUF', p) }); await ws.close(); }
      catch (e) { await ws.abort(); throw e; }
      const bytes = (await vfs.stat(`${dir}/${file}`)).size;
      await vfs.writeJSON(`${dir}/manifest.json`, { id: `${safe}-gguf`, name: `${safe} (GGUF ${ggufType})`, kind: 'llm', engine: 'gguf', gguf: { files: [file] }, params: fmtParams(src.specs), context: Math.min(cfg.maxPos, 8192), bytes, source: { run: run.id }, added: Date.now(), status: 'ready' });
      st('Done', 1);
      return { dir, file };
    }
    throw new Error('Unknown export type ' + what);
  }
}

export async function latestCheckpoint(runDir) {
  const p = await vfs.readJSON(`${runDir}/checkpoint.json`, null);
  return p?.dir && await vfs.exists(`${p.dir}/state.json`) ? p.dir : null;
}

function fmtParams(specs) {
  const n = specs.reduce((a, s) => a + s.shape.reduce((x, y) => x * y, 1), 0);
  return n >= 1e9 ? (n / 1e9).toFixed(1) + 'B' : (n / 1e6).toFixed(0) + 'M';
}
