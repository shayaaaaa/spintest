// Llama-family transformer (Llama 2/3, SmolLM2, Mistral, Qwen2/2.5, Qwen3) for training and inference on WebGPU.
// Training uses activation checkpointing: only each layer's input is kept; the layer is recomputed during backward.
import * as ops from './ops.js';
import { readHeader, readTensor, packF16, quantNF4 } from './safetensors.js';

const SUPPORTED = ['llama', 'mistral', 'qwen2', 'qwen3', 'smollm', 'granite'];

export function normalizeConfig(c) {
  const type = c.model_type || 'llama';
  if (!SUPPORTED.includes(type)) throw new Error(`Model type "${type}" isn't supported for training yet (supported: Llama, SmolLM2, Mistral, Qwen2/2.5, Qwen3).`);
  const H = c.num_attention_heads, D = c.hidden_size;
  return {
    type, D, H, L: c.num_hidden_layers, I: c.intermediate_size, V: c.vocab_size,
    KVH: c.num_key_value_heads || H, hd: c.head_dim || D / H,
    eps: c.rms_norm_eps || 1e-6, theta: c.rope_theta || 10000, ropeScaling: c.rope_scaling || null,
    tied: c.tie_word_embeddings ?? false,
    qkvBias: type === 'qwen2' || c.attention_bias === true,
    qkNorm: type === 'qwen3',
    maxPos: c.max_position_embeddings || 4096,
    bos: c.bos_token_id, eos: c.eos_token_id,
    raw: c,
  };
}

export function invFreq(cfg) {
  const d = cfg.hd;
  const inv = new Float32Array(d / 2);
  for (let i = 0; i < d / 2; i++) inv[i] = 1 / Math.pow(cfg.theta, (2 * i) / d);
  const rs = cfg.ropeScaling;
  if (rs && (rs.rope_type === 'llama3' || rs.type === 'llama3')) {
    const factor = rs.factor, lowF = rs.low_freq_factor || 1, highF = rs.high_freq_factor || 4, orig = rs.original_max_position_embeddings || 8192;
    const lowWl = orig / lowF, highWl = orig / highF;
    for (let i = 0; i < inv.length; i++) {
      const wl = 2 * Math.PI / inv[i];
      if (wl > lowWl) inv[i] = inv[i] / factor;
      else if (wl >= highWl) { const s = (orig / wl - lowF) / (highF - lowF); inv[i] = (1 - s) * inv[i] / factor + s * inv[i]; }
    }
  } else if (rs && (rs.rope_type === 'linear' || rs.type === 'linear')) for (let i = 0; i < inv.length; i++) inv[i] /= rs.factor;
  return inv;
}

const TARGETS = ['q', 'k', 'v', 'o', 'gate', 'up', 'down'];

export class LlamaModel {
  constructor(g, cfg, { mode = 'lora', lora = { r: 16, alpha: 32, targets: TARGETS }, quant = 'f16' } = {}) {
    this.g = g; this.cfg = cfg; this.mode = mode; this.quant = quant;
    this.lora = mode === 'lora' ? { r: lora.r || 16, alpha: lora.alpha || 2 * (lora.r || 16), targets: lora.targets || TARGETS } : null;
    this.loraOn = true;
    this.layers = [];
    this.params = []; // trainable: {name, buf, n, grad, m, v, shape, wd}
    this.inv = g.fromArray(invFreq(cfg), 'rope_inv');
  }

  // ---------- weights ----------
  _frozen(arr, shape, kind) {
    const g = this.g;
    if (this.mode === 'full') return this._trainable(arr, shape, kind);
    if (kind === 'linear' && this.quant === 'nf4' && arr.length % 64 === 0) {
      const { q, scales } = quantNF4(arr);
      return { buf: g.fromArray(q), scales: g.fromArray(scales), dtype: 'nf4', out: shape[0], in: shape[1] };
    }
    if (kind === 'norm' || kind === 'bias') return { buf: g.fromArray(arr), dtype: 'f32', out: shape[0], in: shape[1] || 1 };
    return { buf: g.fromArray(packF16(arr)), dtype: 'f16', out: shape[0], in: shape[1] || 1 };
  }
  _trainable(arr, shape, kind, name) {
    const g = this.g;
    const n = arr.length;
    const p = { name: name || kind, buf: g.fromArray(arr), n, shape, grad: g.buffer(n * 4), m: g.buffer(n * 4), v: g.buffer(n * 4), wd: kind === 'linear' || kind === 'embed' || kind === 'lora' };
    ops.fill(g, p.grad, n, 0); ops.fill(g, p.m, n, 0); ops.fill(g, p.v, n, 0);
    this.params.push(p);
    return { buf: p.buf, dtype: 'f32', out: shape[0], in: shape[1] || 1, param: p };
  }
  _loraFor(name, out, inn) {
    if (!this.lora || !this.lora.targets.includes(name)) return null;
    const r = this.lora.r;
    const bound = 1 / Math.sqrt(inn);
    const A = Float32Array.from({ length: r * inn }, () => (Math.random() * 2 - 1) * bound);
    const B = new Float32Array(out * r);
    return { r, scale: this.lora.alpha / r, A: this._trainable(A, [r, inn], 'lora', `${name}.lora_A`), B: this._trainable(B, [out, r], 'lora', `${name}.lora_B`) };
  }

  // Loads HF safetensors weights from File objects ({name -> File} via `files`, plus optional index map).
  async loadWeights(files, onProgress) {
    const cfg = this.cfg, g = this.g;
    // tensor name -> {file, info, dataStart}
    const where = new Map();
    for (const f of files) { const h = await readHeader(f); for (const [k, info] of Object.entries(h.tensors)) where.set(k, { file: f, info, dataStart: h.dataStart }); }
    const get = async (name, optional = false) => {
      const w = where.get(name);
      if (!w) { if (optional) return null; throw new Error(`Missing tensor ${name}`); }
      return readTensor(w.file, w.info, w.dataStart);
    };
    let done = 0; const total = cfg.L + 2;
    const tick = (t) => onProgress?.({ text: t, progress: ++done / total });
    // Embedding (sharded by rows to respect the max storage binding size).
    const E = await get('model.embed_tokens.weight');
    this.embed = await this._embedShards(E, cfg.V, cfg.D, this.mode === 'full');
    const Wh = cfg.tied ? null : await get('lm_head.weight', true);
    if (!Wh) cfg.tied = true;
    this.lmHead = Wh ? await this._embedShards(Wh, cfg.V, cfg.D, this.mode === 'full') : this.embed;
    tick('Embeddings');
    for (let i = 0; i < cfg.L; i++) {
      const p = `model.layers.${i}.`;
      const lin = async (n, key, out, inn) => {
        const arr = await get(p + key + '.weight');
        const W = this._frozen(arr, [out, inn], 'linear');
        if (W.param) W.param.name = `${i}.${n}`;
        const biasArr = await get(p + key + '.bias', true);
        const bias = biasArr ? this._frozen(biasArr, [out], 'bias') : null;
        return { W, bias, lora: this._loraFor(n, out, inn), out, in: inn, name: n };
      };
      const qd = cfg.H * cfg.hd, kvd = cfg.KVH * cfg.hd;
      const L = {
        ln1: this._frozen(await get(p + 'input_layernorm.weight'), [cfg.D], 'norm'),
        ln2: this._frozen(await get(p + 'post_attention_layernorm.weight'), [cfg.D], 'norm'),
        q: await lin('q', 'self_attn.q_proj', qd, cfg.D),
        k: await lin('k', 'self_attn.k_proj', kvd, cfg.D),
        v: await lin('v', 'self_attn.v_proj', kvd, cfg.D),
        o: await lin('o', 'self_attn.o_proj', cfg.D, qd),
        gate: await lin('gate', 'mlp.gate_proj', cfg.I, cfg.D),
        up: await lin('up', 'mlp.up_proj', cfg.I, cfg.D),
        down: await lin('down', 'mlp.down_proj', cfg.D, cfg.I),
      };
      if (cfg.qkNorm) { L.qn = this._frozen(await get(p + 'self_attn.q_norm.weight'), [cfg.hd], 'norm'); L.kn = this._frozen(await get(p + 'self_attn.k_norm.weight'), [cfg.hd], 'norm'); }
      this.layers.push(L);
      tick(`Layer ${i + 1}/${cfg.L}`);
      if (i % 4 === 3) await g.sync();
    }
    this.norm = this._frozen(await get('model.norm.weight'), [cfg.D], 'norm');
    tick('Done');
    await g.sync();
  }

  // Random init (training from scratch).
  async initRandom(seed = 1) {
    const cfg = this.cfg;
    let s = seed;
    const rnd = () => { s = (s * 16807) % 2147483647; const u = s / 2147483647; s = (s * 16807) % 2147483647; const v = s / 2147483647; return Math.sqrt(-2 * Math.log(u + 1e-12)) * Math.cos(2 * Math.PI * v); };
    const normal = (n, std) => Float32Array.from({ length: n }, () => rnd() * std);
    const ones = (n) => new Float32Array(n).fill(1);
    const std = 0.02, projStd = 0.02 / Math.sqrt(2 * cfg.L);
    this.embed = await this._embedShards(normal(cfg.V * cfg.D, std), cfg.V, cfg.D, true);
    this.lmHead = cfg.tied ? this.embed : await this._embedShards(normal(cfg.V * cfg.D, std), cfg.V, cfg.D, true);
    const qd = cfg.H * cfg.hd, kvd = cfg.KVH * cfg.hd;
    for (let i = 0; i < cfg.L; i++) {
      const lin = (n, out, inn, sd) => ({ W: this._trainable(normal(out * inn, sd), [out, inn], 'linear', `${i}.${n}`), bias: null, lora: null, out, in: inn, name: n });
      this.layers.push({
        ln1: this._trainable(ones(cfg.D), [cfg.D], 'norm', `${i}.ln1`), ln2: this._trainable(ones(cfg.D), [cfg.D], 'norm', `${i}.ln2`),
        q: lin('q', qd, cfg.D, std), k: lin('k', kvd, cfg.D, std), v: lin('v', kvd, cfg.D, std), o: lin('o', cfg.D, qd, projStd),
        gate: lin('gate', cfg.I, cfg.D, std), up: lin('up', cfg.I, cfg.D, std), down: lin('down', cfg.D, cfg.I, projStd),
      });
    }
    this.norm = this._trainable(ones(cfg.D), [cfg.D], 'norm', 'norm');
  }

  async _embedShards(arr, V, D, trainable) {
    const g = this.g;
    const bytesPerRow = D * (trainable ? 4 : 2);
    const maxRows = Math.max(1, Math.floor(Math.min(g.maxBinding, 1 << 30) / bytesPerRow / 64) * 64);
    const shards = [];
    for (let r0 = 0; r0 < V; r0 += maxRows) {
      const rows = Math.min(maxRows, V - r0);
      const slice = arr.subarray(r0 * D, (r0 + rows) * D);
      const w = trainable ? this._trainable(new Float32Array(slice), [rows, D], 'embed', `embed_${r0}`) : { buf: g.fromArray(packF16(slice)), dtype: 'f16', out: rows, in: D };
      shards.push({ ...w, rowStart: r0, rows });
    }
    return shards;
  }

  // ---------- building blocks ----------
  _lin(x, T, lin, y, keep) {
    const g = this.g;
    ops.linear(g, x, lin.W, y, T);
    if (lin.bias) ops.biasAdd(g, y, lin.bias, T, lin.out);
    if (lin.lora && this.loraOn) {
      const u = g.temp(T * lin.lora.r * 4);
      ops.linear(g, x, lin.lora.A, u, T);
      ops.linear(g, u, lin.lora.B, y, T, { acc: true, alpha: lin.lora.scale });
      if (keep) keep.push(['u_' + lin.name, u]); else g.release(u);
      return u;
    }
    return null;
  }

  // dx (+)= dy·W (+ LoRA path); accumulates trainable grads.
  _linBwd(dy, x, u, T, lin, dx, accDx) {
    const g = this.g;
    ops.linearBwdInput(g, dy, lin.W, dx, T, { acc: accDx });
    if (lin.W.param) ops.linearBwdWeight(g, dy, x, lin.W.param.grad, T, lin.out, lin.in);
    if (lin.bias?.param) ops.colsum(g, dy, lin.bias.param.grad, T, lin.out);
    if (lin.lora && this.loraOn) {
      const { r, scale, A, B } = lin.lora;
      ops.linearBwdWeight(g, dy, u, B.param.grad, T, lin.out, r, { alpha: scale });
      const du = g.temp(T * r * 4);
      ops.linearBwdInput(g, dy, B, du, T, { alpha: scale });
      ops.linearBwdWeight(g, du, x, A.param.grad, T, r, lin.in);
      ops.linearBwdInput(g, du, A, dx, T, { acc: true });
      g.release(du);
    }
  }

  embedTokens(idsBuf, T, out) {
    for (const sh of this.embed) ops.embed(this.g, idsBuf, sh, out, T, this.cfg.D, { rowStart: sh.rowStart, rows: sh.rows });
  }

  // One transformer layer forward over T tokens (training: no KV cache). Returns output buffer; `keep` collects
  // intermediates for backward when given.
  _layer(i, x, T, keep) {
    const g = this.g, c = this.cfg, Lw = this.layers[i];
    const D = c.D, qd = c.H * c.hd, kvd = c.KVH * c.hd;
    const hn = g.temp(T * D * 4), r1 = g.temp(T * 4);
    ops.rmsnorm(g, x, Lw.ln1, hn, r1, T, D, c.eps);
    const q = g.temp(T * qd * 4), k = g.temp(T * kvd * 4), v = g.temp(T * kvd * 4);
    const uq = this._lin(hn, T, Lw.q, q, keep), uk = this._lin(hn, T, Lw.k, k, keep), uv = this._lin(hn, T, Lw.v, v, keep);
    let qPre = null, kPre = null, rq = null, rk = null;
    if (c.qkNorm) {
      qPre = g.temp(T * qd * 4); kPre = g.temp(T * kvd * 4); rq = g.temp(T * c.H * 4); rk = g.temp(T * c.KVH * 4);
      ops.copy(g, q, qPre, T * qd); ops.copy(g, k, kPre, T * kvd);
      ops.rmsnorm(g, qPre, Lw.qn, q, rq, T * c.H, c.hd, c.eps);
      ops.rmsnorm(g, kPre, Lw.kn, k, rk, T * c.KVH, c.hd, c.eps);
    }
    ops.rope(g, q, this.inv, T, c.H, c.hd, 0);
    ops.rope(g, k, this.inv, T, c.KVH, c.hd, 0);
    const S = g.temp(c.H * T * T * 4);
    ops.matmul(g, { A: q, B: k, C: S, M: T, N: T, Kd: c.hd, batch: c.H, sAm: qd, sAk: 1, sAz: c.hd, sBk: 1, sBn: kvd, sBz: c.hd, bDiv: c.H / c.KVH, sCm: T, sCz: T * T });
    ops.softmax(g, S, c.H * T, T, T, 0, 1 / Math.sqrt(c.hd));
    const O = g.temp(T * qd * 4);
    ops.matmul(g, { A: S, B: v, C: O, M: T, N: c.hd, Kd: T, batch: c.H, sAm: T, sAk: 1, sAz: T * T, sBk: kvd, sBn: 1, sBz: c.hd, bDiv: c.H / c.KVH, cOff: 0, sCm: qd, sCz: c.hd });
    const a = g.temp(T * D * 4);
    const uo = this._lin(O, T, Lw.o, a, keep);
    const x2 = g.temp(T * D * 4);
    ops.add(g, x, a, x2, T * D);
    g.release(a);
    const hn2 = g.temp(T * D * 4), r2 = g.temp(T * 4);
    ops.rmsnorm(g, x2, Lw.ln2, hn2, r2, T, D, c.eps);
    const gt = g.temp(T * c.I * 4), up = g.temp(T * c.I * 4);
    const ug = this._lin(hn2, T, Lw.gate, gt, keep), uu = this._lin(hn2, T, Lw.up, up, keep);
    const m = g.temp(T * c.I * 4);
    ops.swiglu(g, gt, up, m, T * c.I);
    const dn = g.temp(T * D * 4);
    const ud = this._lin(m, T, Lw.down, dn, keep);
    const out = g.temp(T * D * 4);
    ops.add(g, x2, dn, out, T * D);
    g.release(dn);
    const tmp = { hn, r1, q, k, v, qPre, kPre, rq, rk, S, O, x2, hn2, r2, gt, up, m };
    if (keep) { keep.push(['tmp', tmp]); keep.u = { q: uq, k: uk, v: uv, o: uo, gate: ug, up: uu, down: ud }; }
    else for (const b of Object.values(tmp)) g.release(b);
    return out;
  }

  // Backward through layer i given its input x and dOut; returns dx (new buffer).
  _layerBwd(i, x, T, dOut) {
    const g = this.g, c = this.cfg, Lw = this.layers[i];
    const D = c.D, qd = c.H * c.hd, kvd = c.KVH * c.hd;
    const keep = [];
    const out = this._layer(i, x, T, keep);
    g.release(out);
    const t = keep.find(k => k[0] === 'tmp')[1];
    const U = keep.u;
    // out = x2 + down(m)
    const dm = g.temp(T * c.I * 4);
    this._linBwd(dOut, t.m, U.down, T, Lw.down, dm, false);
    const dgt = g.temp(T * c.I * 4), dup = g.temp(T * c.I * 4);
    ops.swigluBwd(g, dm, t.gt, t.up, dgt, dup, T * c.I);
    g.release(dm);
    const dhn2 = g.temp(T * D * 4);
    this._linBwd(dgt, t.hn2, U.gate, T, Lw.gate, dhn2, false);
    this._linBwd(dup, t.hn2, U.up, T, Lw.up, dhn2, true);
    g.release(dgt); g.release(dup);
    const dx2 = g.temp(T * D * 4);
    ops.copy(g, dOut, dx2, T * D);
    ops.rmsnormBwd(g, t.x2, Lw.ln2, dhn2, t.r2, dx2, T, D, { acc: true });
    if (Lw.ln2.param) ops.rmsnormDW(g, t.x2, dhn2, t.r2, Lw.ln2.param.grad, T, D);
    g.release(dhn2);
    // x2 = x + o(O)
    const dO = g.temp(T * qd * 4);
    this._linBwd(dx2, t.O, U.o, T, Lw.o, dO, false);
    // attention backward
    const dP = g.temp(c.H * T * T * 4);
    ops.matmul(g, { A: dO, B: t.v, C: dP, M: T, N: T, Kd: c.hd, batch: c.H, sAm: qd, sAk: 1, sAz: c.hd, sBk: 1, sBn: kvd, sBz: c.hd, bDiv: c.H / c.KVH, sCm: T, sCz: T * T });
    const dv = g.temp(T * kvd * 4), dk = g.temp(T * kvd * 4), dq = g.temp(T * qd * 4);
    ops.fill(g, dv, T * kvd, 0); ops.fill(g, dk, T * kvd, 0);
    const grp = c.H / c.KVH;
    for (let h = 0; h < c.H; h++) {
      const kh = Math.floor(h / grp);
      // dV[s, kh] += P[h]ᵀ[s, t] · dO[t, h]
      ops.matmul(g, { A: t.S, B: dO, C: dv, M: T, N: c.hd, Kd: T, aOff: h * T * T, sAm: 1, sAk: T, bOff: h * c.hd, sBk: qd, sBn: 1, cOff: kh * c.hd, sCm: kvd, acc: true });
    }
    g.release(dO);
    ops.softmaxBwd(g, t.S, dP, c.H * T, T, 1 / Math.sqrt(c.hd));
    // dQ[t, h] = dS[h] · K[s, kh]
    ops.matmul(g, { A: dP, B: t.k, C: dq, M: T, N: c.hd, Kd: T, batch: c.H, sAm: T, sAk: 1, sAz: T * T, sBk: kvd, sBn: 1, sBz: c.hd, bDiv: grp, sCm: qd, sCz: c.hd });
    for (let h = 0; h < c.H; h++) {
      const kh = Math.floor(h / grp);
      // dK[s, kh] += dS[h]ᵀ[s, t] · Q[t, h]
      ops.matmul(g, { A: dP, B: t.q, C: dk, M: T, N: c.hd, Kd: T, aOff: h * T * T, sAm: 1, sAk: T, bOff: h * c.hd, sBk: qd, sBn: 1, cOff: kh * c.hd, sCm: kvd, acc: true });
    }
    g.release(dP);
    ops.rope(g, dq, this.inv, T, c.H, c.hd, 0, { sign: -1 });
    ops.rope(g, dk, this.inv, T, c.KVH, c.hd, 0, { sign: -1 });
    let dqIn = dq, dkIn = dk;
    if (c.qkNorm) {
      dqIn = g.temp(T * qd * 4); dkIn = g.temp(T * kvd * 4);
      ops.rmsnormBwd(g, t.qPre, Lw.qn, dq, t.rq, dqIn, T * c.H, c.hd);
      ops.rmsnormBwd(g, t.kPre, Lw.kn, dk, t.rk, dkIn, T * c.KVH, c.hd);
      if (Lw.qn.param) ops.rmsnormDW(g, t.qPre, dq, t.rq, Lw.qn.param.grad, T * c.H, c.hd);
      if (Lw.kn.param) ops.rmsnormDW(g, t.kPre, dk, t.rk, Lw.kn.param.grad, T * c.KVH, c.hd);
      g.release(dq); g.release(dk);
    }
    const dhn = g.temp(T * D * 4);
    this._linBwd(dqIn, t.hn, U.q, T, Lw.q, dhn, false);
    this._linBwd(dkIn, t.hn, U.k, T, Lw.k, dhn, true);
    this._linBwd(dv, t.hn, U.v, T, Lw.v, dhn, true);
    g.release(dqIn); g.release(dkIn); g.release(dv);
    const dx = g.temp(T * D * 4);
    ops.copy(g, dx2, dx, T * D);
    ops.rmsnormBwd(g, x, Lw.ln1, dhn, t.r1, dx, T, D, { acc: true });
    if (Lw.ln1.param) ops.rmsnormDW(g, x, dhn, t.r1, Lw.ln1.param.grad, T, D);
    g.release(dhn); g.release(dx2);
    for (const b of Object.values(t)) g.release(b);
    for (const [n, b] of keep) if (n.startsWith('u_')) g.release(b);
    return dx;
  }

  // Forward for training: returns {h (final normed hidden), xs (layer inputs), xLast, rF}.
  forwardTrain(ids) {
    const g = this.g, c = this.cfg, T = ids.length;
    const idsBuf = g.fromArray(Uint32Array.from(ids));
    let x = g.temp(T * c.D * 4);
    this.embedTokens(idsBuf, T, x);
    const xs = [];
    for (let i = 0; i < c.L; i++) {
      xs.push(x);
      x = this._layer(i, x, T, null);
      if (i % 2 === 1) g.flush();
    }
    const h = g.temp(T * c.D * 4), rF = g.temp(T * 4);
    ops.rmsnorm(g, x, this.norm, h, rF, T, c.D, c.eps);
    return { h, xs, xLast: x, rF, T, idsBuf };
  }

  // Logits + log-probs (+ dh if coef given). labels: Int32Array(T) (-1 = ignore); coef: Float32Array(T) or null.
  async lossPass(h, T, labels, coef) {
    const g = this.g, c = this.cfg;
    const V = c.V;
    const rowsPer = Math.max(1, Math.min(T, Math.floor(Math.min(g.maxBinding, 256 * 1024 * 1024) / (V * 4))));
    const lp = new Float32Array(T);
    const dh = coef ? g.temp(T * c.D * 4) : null;
    if (dh) ops.fill(g, dh, T * c.D, 0);
    const logits = g.temp(rowsPer * V * 4);
    const lpBuf = g.temp(rowsPer * 4);
    for (let r0 = 0; r0 < T; r0 += rowsPer) {
      const R = Math.min(rowsPer, T - r0);
      for (const sh of this.lmHead) ops.linear(g, h, sh, logits, R, { xOff: r0 * c.D, yOff: sh.rowStart, ldy: V });
      const lab = g.fromArray(labels.subarray(r0, r0 + R));
      const cf = g.fromArray(coef ? coef.subarray(r0, r0 + R) : new Float32Array(R));
      ops.xent(g, logits, lab, cf, lpBuf, R, V);
      lp.set(await g.readF32(lpBuf, R), r0);
      if (dh) {
        for (const sh of this.lmHead) {
          // dh[r] += dlogits[r, shard] · E_shard
          ops.matmul(g, { A: logits, B: sh.buf, bdtype: sh.dtype, bScales: sh.scales, C: dh, M: R, N: c.D, Kd: sh.rows, aOff: sh.rowStart, sAm: V, sAk: 1, sBk: c.D, sBn: 1, cOff: r0 * c.D, sCm: c.D, acc: true });
          if (sh.param) ops.matmul(g, { A: logits, B: h, C: sh.param.grad, M: sh.rows, N: c.D, Kd: R, aOff: sh.rowStart, sAm: 1, sAk: V, bOff: r0 * c.D, sBk: c.D, sBn: 1, sCm: c.D, acc: true });
        }
      }
      g.free(lab); g.free(cf);
    }
    g.release(logits); g.release(lpBuf);
    return { lp, dh };
  }

  // Backward from dh (grad wrt final normed hidden) through all layers; accumulates param grads.
  backward(fw, dh) {
    const g = this.g, c = this.cfg, T = fw.T;
    let dx = g.temp(T * c.D * 4);
    ops.rmsnormBwd(g, fw.xLast, this.norm, dh, fw.rF, dx, T, c.D);
    if (this.norm.param) ops.rmsnormDW(g, fw.xLast, dh, fw.rF, this.norm.param.grad, T, c.D);
    for (let i = c.L - 1; i >= 0; i--) {
      const ndx = this._layerBwd(i, fw.xs[i], T, dx);
      g.release(dx);
      dx = ndx;
      g.flush();
    }
    if (this.embed[0].param) for (const sh of this.embed) ops.embedBwd(g, fw.idsBuf, dx, sh.param.grad, T, c.D, { rowStart: sh.rowStart, rows: sh.rows });
    g.release(dx);
  }

  freeForward(fw) {
    const g = this.g;
    for (const b of fw.xs) g.release(b);
    g.release(fw.xLast); g.release(fw.h); g.release(fw.rF); g.free(fw.idsBuf);
  }

  // ---------- optimizer ----------
  async gradNorm() {
    let s = 0;
    for (const p of this.params) s += await ops.sumsq(this.g, p.grad, p.n);
    return Math.sqrt(s);
  }
  step({ step, lr, wd = 0, clip = 1, gnorm, b1 = 0.9, b2 = 0.999, eps = 1e-8, gscale = 1 }) {
    const scale = gscale * (clip && gnorm > clip ? clip / gnorm : 1);
    for (const p of this.params) ops.adamw(this.g, p.buf, p.grad, p.m, p.v, p.n, { step, lr, b1, b2, eps, wd: p.wd ? wd : 0, gscale: scale });
  }
  zeroGrad() { for (const p of this.params) ops.fill(this.g, p.grad, p.n, 0); }
  numTrainable() { return this.params.reduce((a, p) => a + p.n, 0); }

  // ---------- inference with KV cache ----------
  allocCache(maxT) {
    const g = this.g, c = this.cfg, kvd = c.KVH * c.hd;
    this.freeCache();
    this.cache = { maxT, pos: 0, K: [], V: [] };
    for (let i = 0; i < c.L; i++) { this.cache.K.push(g.buffer(maxT * kvd * 4)); this.cache.V.push(g.buffer(maxT * kvd * 4)); }
  }
  freeCache() { if (this.cache) { for (const b of [...this.cache.K, ...this.cache.V]) this.g.free(b); this.cache = null; } }

  // Runs T new tokens at position cache.pos; returns logits (Float32Array V) for the last token.
  async forwardInfer(ids) {
    const g = this.g, c = this.cfg, T = ids.length, D = c.D, qd = c.H * c.hd, kvd = c.KVH * c.hd;
    const pos0 = this.cache.pos;
    if (pos0 + T > this.cache.maxT) throw new Error('Context is full');
    const Tk = pos0 + T;
    const idsBuf = g.fromArray(Uint32Array.from(ids));
    let x = g.temp(T * D * 4);
    this.embedTokens(idsBuf, T, x);
    for (let i = 0; i < c.L; i++) {
      const Lw = this.layers[i];
      const hn = g.temp(T * D * 4), r = g.temp(Math.max(T, T * c.H) * 4);
      ops.rmsnorm(g, x, Lw.ln1, hn, r, T, D, c.eps);
      const q = g.temp(T * qd * 4), k = g.temp(T * kvd * 4), v = g.temp(T * kvd * 4);
      this._lin(hn, T, Lw.q, q); this._lin(hn, T, Lw.k, k); this._lin(hn, T, Lw.v, v);
      if (c.qkNorm) {
        const qq = g.temp(T * qd * 4), kk = g.temp(T * kvd * 4);
        ops.rmsnorm(g, q, Lw.qn, qq, r, T * c.H, c.hd, c.eps); ops.copy(g, qq, q, T * qd);
        ops.rmsnorm(g, k, Lw.kn, kk, r, T * c.KVH, c.hd, c.eps); ops.copy(g, kk, k, T * kvd);
        g.release(qq); g.release(kk);
      }
      ops.rope(g, q, this.inv, T, c.H, c.hd, pos0);
      ops.rope(g, k, this.inv, T, c.KVH, c.hd, pos0);
      ops.copy2d(g, k, this.cache.K[i], T, kvd, { dstOff: pos0 * kvd });
      ops.copy2d(g, v, this.cache.V[i], T, kvd, { dstOff: pos0 * kvd });
      const S = g.temp(c.H * T * Tk * 4);
      ops.matmul(g, { A: q, B: this.cache.K[i], C: S, M: T, N: Tk, Kd: c.hd, batch: c.H, sAm: qd, sAk: 1, sAz: c.hd, sBk: 1, sBn: kvd, sBz: c.hd, bDiv: c.H / c.KVH, sCm: Tk, sCz: T * Tk });
      ops.softmax(g, S, c.H * T, T, Tk, pos0, 1 / Math.sqrt(c.hd));
      const O = g.temp(T * qd * 4);
      ops.matmul(g, { A: S, B: this.cache.V[i], C: O, M: T, N: c.hd, Kd: Tk, batch: c.H, sAm: Tk, sAk: 1, sAz: T * Tk, sBk: kvd, sBn: 1, sBz: c.hd, bDiv: c.H / c.KVH, sCm: qd, sCz: c.hd });
      this._lin(O, T, Lw.o, hn); // hn reused as attention output
      ops.add(g, x, hn, x, T * D);
      ops.rmsnorm(g, x, Lw.ln2, hn, r, T, D, c.eps);
      const gt = g.temp(T * c.I * 4), up = g.temp(T * c.I * 4), m = g.temp(T * c.I * 4);
      this._lin(hn, T, Lw.gate, gt); this._lin(hn, T, Lw.up, up);
      ops.swiglu(g, gt, up, m, T * c.I);
      this._lin(m, T, Lw.down, hn);
      ops.add(g, x, hn, x, T * D);
      for (const b of [hn, r, q, k, v, S, O, gt, up, m]) g.release(b);
    }
    const last = g.temp(D * 4), rr = g.temp(16);
    ops.rmsnorm(g, x, this.norm, last, rr, 1, D, c.eps, { xOff: (T - 1) * D });
    const logits = g.temp(c.V * 4);
    for (const sh of this.lmHead) ops.linear(g, last, sh, logits, 1, { yOff: sh.rowStart, ldy: c.V });
    const out = await g.readF32(logits, c.V);
    for (const b of [x, last, rr, logits]) g.release(b);
    g.free(idsBuf);
    this.cache.pos += T;
    return out;
  }

  // Sampling loop. Returns generated token ids (stops at any id in `stop`).
  async generate(promptIds, { maxNew = 256, temperature = 0.7, topP = 0.9, topK = 50, stop = [], onToken, signal, repetitionPenalty = 1.05 } = {}) {
    const total = Math.min(this.cfg.maxPos, promptIds.length + maxNew + 1);
    if (!this.cache || this.cache.maxT < total) this.allocCache(Math.max(total, 512));
    this.cache.pos = 0;
    let logits = await this.forwardInfer(promptIds);
    const out = [];
    const seen = new Set(promptIds.slice(-64));
    for (let i = 0; i < maxNew; i++) {
      if (signal?.aborted) break;
      const id = sample(logits, { temperature, topP, topK, repetitionPenalty, seen });
      if (stop.includes(id)) break;
      out.push(id); seen.add(id);
      onToken?.(id, out);
      if (this.cache.pos >= this.cache.maxT - 1) break;
      logits = await this.forwardInfer([id]);
    }
    return out;
  }

  destroy() {
    this.freeCache();
    this.g.trimPool();
    try { this.g.device.destroy(); } catch {}
  }
}

export function sample(logits, { temperature = 0.7, topP = 0.9, topK = 50, repetitionPenalty = 1, seen } = {}) {
  const V = logits.length;
  if (repetitionPenalty !== 1 && seen) for (const id of seen) logits[id] = logits[id] > 0 ? logits[id] / repetitionPenalty : logits[id] * repetitionPenalty;
  if (!temperature || temperature <= 0.01) { let b = 0; for (let i = 1; i < V; i++) if (logits[i] > logits[b]) b = i; return b; }
  // top-k
  const k = Math.min(topK || V, V);
  const idx = new Int32Array(k).fill(-1), val = new Float32Array(k).fill(-Infinity);
  for (let i = 0; i < V; i++) {
    const v = logits[i];
    if (v <= val[k - 1]) continue;
    let j = k - 1; while (j > 0 && val[j - 1] < v) { val[j] = val[j - 1]; idx[j] = idx[j - 1]; j--; }
    val[j] = v; idx[j] = i;
  }
  const m = val[0];
  const p = Array.from(val, v => Math.exp((v - m) / temperature));
  const s = p.reduce((a, b) => a + b, 0);
  let acc = 0, cut = k;
  for (let i = 0; i < k; i++) { acc += p[i] / s; if (acc >= topP) { cut = i + 1; break; } }
  const s2 = p.slice(0, cut).reduce((a, b) => a + b, 0);
  let r = Math.random() * s2;
  for (let i = 0; i < cut; i++) { r -= p[i]; if (r <= 0) return idx[i]; }
  return idx[0];
}
