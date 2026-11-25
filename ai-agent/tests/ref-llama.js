// Plain-JS reference forward pass for Llama-family models (float64 accumulation). Used by tests only.
// W: Map/obj of HF tensor name -> Float32Array. Returns logits Float32Array(T*V).
export function refForward(cfg, W, ids, { lastOnly = false } = {}) {
  const { D, H, KVH, hd, L, I, V, eps, theta } = cfg;
  const T = ids.length, qd = H * hd, kvd = KVH * hd, grp = H / KVH;
  const w = (n) => { const a = W[n] ?? W.get?.(n); if (!a) throw new Error('ref: missing ' + n); return a; };
  const opt = (n) => W[n] ?? W.get?.(n) ?? null;
  const rms = (x, off, n, wt, out, oOff) => { let s = 0; for (let i = 0; i < n; i++) s += x[off + i] * x[off + i]; const r = 1 / Math.sqrt(s / n + eps); for (let i = 0; i < n; i++) out[oOff + i] = x[off + i] * r * wt[i]; };
  const lin = (x, Wt, bias, rows, inn, out) => { const y = new Float32Array(rows * out); for (let t = 0; t < rows; t++) for (let o = 0; o < out; o++) { let s = 0; const xo = t * inn, wo = o * inn; for (let k = 0; k < inn; k++) s += x[xo + k] * Wt[wo + k]; y[t * out + o] = s + (bias ? bias[o] : 0); } return y; };
  const inv = cfg.invFreq || Float64Array.from({ length: hd / 2 }, (_, i) => 1 / Math.pow(theta, (2 * i) / hd));
  const rope = (x, heads) => { for (let t = 0; t < T; t++) for (let h = 0; h < heads; h++) { const b = t * heads * hd + h * hd; for (let i = 0; i < hd / 2; i++) { const a = t * inv[i], c = Math.cos(a), s = Math.sin(a); const x1 = x[b + i], x2 = x[b + i + hd / 2]; x[b + i] = x1 * c - x2 * s; x[b + i + hd / 2] = x2 * c + x1 * s; } } };
  const E = w('model.embed_tokens.weight');
  let x = new Float32Array(T * D);
  for (let t = 0; t < T; t++) x.set(E.subarray(ids[t] * D, ids[t] * D + D), t * D);
  for (let l = 0; l < L; l++) {
    const p = `model.layers.${l}.`;
    const hn = new Float32Array(T * D);
    for (let t = 0; t < T; t++) rms(x, t * D, D, w(p + 'input_layernorm.weight'), hn, t * D);
    const q = lin(hn, w(p + 'self_attn.q_proj.weight'), opt(p + 'self_attn.q_proj.bias'), T, D, qd);
    const k = lin(hn, w(p + 'self_attn.k_proj.weight'), opt(p + 'self_attn.k_proj.bias'), T, D, kvd);
    const v = lin(hn, w(p + 'self_attn.v_proj.weight'), opt(p + 'self_attn.v_proj.bias'), T, D, kvd);
    if (cfg.qkNorm) {
      const qn = w(p + 'self_attn.q_norm.weight'), kn = w(p + 'self_attn.k_norm.weight');
      for (let r = 0; r < T * H; r++) rms(q, r * hd, hd, qn, q, r * hd);
      for (let r = 0; r < T * KVH; r++) rms(k, r * hd, hd, kn, k, r * hd);
    }
    rope(q, H); rope(k, KVH);
    const O = new Float32Array(T * qd);
    const sc = 1 / Math.sqrt(hd);
    for (let h = 0; h < H; h++) {
      const kh = Math.floor(h / grp);
      for (let t = 0; t < T; t++) {
        const s = new Float64Array(t + 1); let m = -Infinity;
        for (let j = 0; j <= t; j++) { let d = 0; for (let i = 0; i < hd; i++) d += q[t * qd + h * hd + i] * k[j * kvd + kh * hd + i]; s[j] = d * sc; m = Math.max(m, s[j]); }
        let z = 0; for (let j = 0; j <= t; j++) { s[j] = Math.exp(s[j] - m); z += s[j]; }
        for (let i = 0; i < hd; i++) { let acc = 0; for (let j = 0; j <= t; j++) acc += s[j] / z * v[j * kvd + kh * hd + i]; O[t * qd + h * hd + i] = acc; }
      }
    }
    const a = lin(O, w(p + 'self_attn.o_proj.weight'), null, T, qd, D);
    for (let i = 0; i < T * D; i++) x[i] += a[i];
    const hn2 = new Float32Array(T * D);
    for (let t = 0; t < T; t++) rms(x, t * D, D, w(p + 'post_attention_layernorm.weight'), hn2, t * D);
    const gt = lin(hn2, w(p + 'mlp.gate_proj.weight'), null, T, D, I), up = lin(hn2, w(p + 'mlp.up_proj.weight'), null, T, D, I);
    for (let i = 0; i < T * I; i++) gt[i] = gt[i] / (1 + Math.exp(-gt[i])) * up[i];
    const dn = lin(gt, w(p + 'mlp.down_proj.weight'), null, T, I, D);
    for (let i = 0; i < T * D; i++) x[i] += dn[i];
  }
  const rows = lastOnly ? 1 : T, start = lastOnly ? T - 1 : 0;
  const h = new Float32Array(rows * D);
  for (let t = 0; t < rows; t++) rms(x, (start + t) * D, D, w('model.norm.weight'), h, t * D);
  return lin(h, opt('lm_head.weight') || E, null, rows, D, V);
}

// Mean next-token cross-entropy over positions with label >= 0.
export function refLoss(logits, labels, V) {
  let s = 0, n = 0;
  for (let t = 0; t < labels.length; t++) {
    if (labels[t] < 0) continue;
    let m = -Infinity; for (let j = 0; j < V; j++) m = Math.max(m, logits[t * V + j]);
    let z = 0; for (let j = 0; j < V; j++) z += Math.exp(logits[t * V + j] - m);
    s += -(logits[t * V + labels[t]] - m - Math.log(z)); n++;
  }
  return s / n;
}

// Random tiny HF-style checkpoint for tests.
export function tinyCheckpoint(type, { D = 64, H = 4, KVH = 2, L = 2, I = 96, V = 97, seed = 7 } = {}) {
  let s = seed;
  const rnd = () => { s = (s * 16807) % 2147483647; return (s / 2147483647) * 2 - 1; };
  const rand = (n, sc) => Float32Array.from({ length: n }, () => rnd() * sc);
  const hd = D / H, qd = H * hd, kvd = KVH * hd;
  const config = { model_type: type, hidden_size: D, num_attention_heads: H, num_key_value_heads: KVH, num_hidden_layers: L, intermediate_size: I, vocab_size: V, rms_norm_eps: 1e-6, rope_theta: 10000, tie_word_embeddings: type !== 'llama', max_position_embeddings: 256 };
  if (type === 'qwen3') config.head_dim = hd;
  const W = {};
  W['model.embed_tokens.weight'] = rand(V * D, 0.5);
  for (let l = 0; l < L; l++) {
    const p = `model.layers.${l}.`;
    W[p + 'input_layernorm.weight'] = Float32Array.from({ length: D }, () => 1 + rnd() * 0.2);
    W[p + 'post_attention_layernorm.weight'] = Float32Array.from({ length: D }, () => 1 + rnd() * 0.2);
    W[p + 'self_attn.q_proj.weight'] = rand(qd * D, 0.3);
    W[p + 'self_attn.k_proj.weight'] = rand(kvd * D, 0.3);
    W[p + 'self_attn.v_proj.weight'] = rand(kvd * D, 0.3);
    W[p + 'self_attn.o_proj.weight'] = rand(D * qd, 0.3);
    if (type === 'qwen2') { W[p + 'self_attn.q_proj.bias'] = rand(qd, 0.2); W[p + 'self_attn.k_proj.bias'] = rand(kvd, 0.2); W[p + 'self_attn.v_proj.bias'] = rand(kvd, 0.2); }
    if (type === 'qwen3') { W[p + 'self_attn.q_norm.weight'] = Float32Array.from({ length: hd }, () => 1 + rnd() * 0.2); W[p + 'self_attn.k_norm.weight'] = Float32Array.from({ length: hd }, () => 1 + rnd() * 0.2); }
    W[p + 'mlp.gate_proj.weight'] = rand(I * D, 0.3);
    W[p + 'mlp.up_proj.weight'] = rand(I * D, 0.3);
    W[p + 'mlp.down_proj.weight'] = rand(D * I, 0.3);
  }
  W['model.norm.weight'] = Float32Array.from({ length: D }, () => 1 + rnd() * 0.2);
  if (type === 'llama') W['lm_head.weight'] = rand(V * D, 0.5);
  return { config, W };
}
