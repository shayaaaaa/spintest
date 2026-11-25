// Export helpers: PEFT adapter config, HF→GGUF tensor naming and a streaming GGUF v3 writer (F32/F16/Q8_0 tensors,
// llama.cpp tokenizer metadata from tokenizer.json).
import { f32ToF16 } from './safetensors.js';
import { invFreq } from './model.js';

export const PEFT_MODULES = { q: 'q_proj', k: 'k_proj', v: 'v_proj', o: 'o_proj', gate: 'gate_proj', up: 'up_proj', down: 'down_proj' };

export function adapterConfig({ r, alpha, targets, base }) {
  return {
    peft_type: 'LORA', task_type: 'CAUSAL_LM', base_model_name_or_path: base || null, revision: null,
    r, lora_alpha: alpha, lora_dropout: 0, bias: 'none', fan_in_fan_out: false, inference_mode: true,
    target_modules: targets.map(t => PEFT_MODULES[t] || t), modules_to_save: null, use_rslora: false, use_dora: false,
    init_lora_weights: true, layers_to_transform: null, layers_pattern: null,
  };
}

// ---------- GGUF ----------
const GT = { UINT8: 0, INT8: 1, UINT16: 2, INT16: 3, UINT32: 4, INT32: 5, FLOAT32: 6, BOOL: 7, STRING: 8, ARRAY: 9, UINT64: 10, INT64: 11, FLOAT64: 12 };
const TT = { F32: 0, F16: 1, Q8_0: 8 };
const ALIGN = 32;

export function ggufArch(cfg) { return cfg.type === 'qwen2' ? 'qwen2' : cfg.type === 'qwen3' ? 'qwen3' : 'llama'; }

export function ggufName(hf) {
  if (hf === 'model.embed_tokens.weight') return 'token_embd.weight';
  if (hf === 'model.norm.weight') return 'output_norm.weight';
  if (hf === 'lm_head.weight') return 'output.weight';
  const m = /^model\.layers\.(\d+)\.(.+)$/.exec(hf);
  if (!m) return null;
  const map = {
    'input_layernorm.weight': 'attn_norm.weight', 'post_attention_layernorm.weight': 'ffn_norm.weight',
    'self_attn.q_proj.weight': 'attn_q.weight', 'self_attn.k_proj.weight': 'attn_k.weight', 'self_attn.v_proj.weight': 'attn_v.weight', 'self_attn.o_proj.weight': 'attn_output.weight',
    'self_attn.q_proj.bias': 'attn_q.bias', 'self_attn.k_proj.bias': 'attn_k.bias', 'self_attn.v_proj.bias': 'attn_v.bias',
    'self_attn.q_norm.weight': 'attn_q_norm.weight', 'self_attn.k_norm.weight': 'attn_k_norm.weight',
    'mlp.gate_proj.weight': 'ffn_gate.weight', 'mlp.up_proj.weight': 'ffn_up.weight', 'mlp.down_proj.weight': 'ffn_down.weight',
  };
  return map[m[2]] ? `blk.${m[1]}.${map[m[2]]}` : null;
}

// HF Llama checkpoints store Q/K rows in rotate-half order; llama.cpp's llama arch expects the original interleaved order.
export function permuteQK(w, nHead, rows, cols) {
  const out = new Float32Array(w.length);
  const hd = rows / nHead, half = hd / 2;
  for (let h = 0; h < nHead; h++) for (let i = 0; i < half; i++) for (let j = 0; j < 2; j++) {
    const src = h * hd + j * half + i, dst = h * hd + i * 2 + j;
    out.set(w.subarray(src * cols, src * cols + cols), dst * cols);
  }
  return out;
}

function quantQ8_0(arr) {
  const nb = arr.length / 32;
  const out = new Uint8Array(nb * 34);
  const dv = new DataView(out.buffer);
  const d16 = new Float32Array(nb);
  for (let b = 0; b < nb; b++) { let am = 0; for (let i = 0; i < 32; i++) am = Math.max(am, Math.abs(arr[b * 32 + i])); d16[b] = am / 127; }
  const dh = f32ToF16(d16);
  for (let b = 0; b < nb; b++) {
    dv.setUint16(b * 34, dh[b], true);
    const d = d16[b], id = d ? 1 / d : 0;
    for (let i = 0; i < 32; i++) dv.setInt8(b * 34 + 2 + i, Math.max(-127, Math.min(127, Math.round(arr[b * 32 + i] * id))));
  }
  return out;
}

class W {
  constructor() { this.buf = new Uint8Array(1 << 20); this.n = 0; this.dv = new DataView(this.buf.buffer); }
  need(k) { if (this.n + k <= this.buf.length) return; let L = this.buf.length; while (L < this.n + k) L *= 2; const nb = new Uint8Array(L); nb.set(this.buf.subarray(0, this.n)); this.buf = nb; this.dv = new DataView(nb.buffer); }
  u8(v) { this.need(1); this.dv.setUint8(this.n, v); this.n += 1; }
  u32(v) { this.need(4); this.dv.setUint32(this.n, v, true); this.n += 4; }
  i32(v) { this.need(4); this.dv.setInt32(this.n, v, true); this.n += 4; }
  f32(v) { this.need(4); this.dv.setFloat32(this.n, v, true); this.n += 4; }
  u64(v) { this.need(8); this.dv.setBigUint64(this.n, BigInt(v), true); this.n += 8; }
  str(s) { const b = new TextEncoder().encode(s); this.u64(b.length); this.need(b.length); this.buf.set(b, this.n); this.n += b.length; }
  pad(a) { while (this.n % a) this.u8(0); }
  bytes() { return this.buf.subarray(0, this.n); }
}

function kv(w, key, type, value) {
  w.str(key); w.u32(type);
  const one = (t, v) => { if (t === GT.UINT32) w.u32(v); else if (t === GT.INT32) w.i32(v); else if (t === GT.FLOAT32) w.f32(v); else if (t === GT.BOOL) w.u8(v ? 1 : 0); else if (t === GT.STRING) w.str(v); else if (t === GT.UINT64) w.u64(v); else throw new Error('gguf type'); };
  if (type === GT.ARRAY) { const [t, arr] = value; w.u32(t); w.u64(arr.length); for (const v of arr) one(t, v); }
  else one(type, value);
}

// Builds tokenizer metadata in llama.cpp's format from an HF tokenizer.json.
export function ggufTokenizer(tj, tcfg, hfCfg, genCfg, V, cfg) {
  const model = tj.model || {};
  const vocab = model.vocab || {};
  const tokens = new Array(V).fill(null), types = new Array(V).fill(1);
  if (Array.isArray(vocab)) vocab.forEach(([t], i) => { if (i < V) tokens[i] = t; }); else for (const [t, id] of Object.entries(vocab)) if (id < V) tokens[id] = t;
  const added = tj.added_tokens || [];
  for (const a of added) if (a.id < V) { tokens[a.id] = a.content; types[a.id] = a.special ? 3 : 4; }
  for (let i = 0; i < V; i++) if (tokens[i] == null) { tokens[i] = `[PAD${i}]`; types[i] = 5; }
  const byteLevel = JSON.stringify(tj.pre_tokenizer || {}).includes('ByteLevel') || tj.decoder?.type === 'ByteLevel';
  const out = [];
  const id = (s) => { if (s == null) return null; const c = typeof s === 'object' ? s.content : s; const a = added.find(x => x.content === c); if (a) return a.id; const v = Array.isArray(vocab) ? vocab.findIndex(([t]) => t === c) : vocab[c]; return v == null || v < 0 ? null : v; };
  if (byteLevel) {
    out.push(['tokenizer.ggml.model', GT.STRING, 'gpt2']);
    const pt = JSON.stringify(tj.pre_tokenizer || {});
    let pre = 'gpt-2';
    if (cfg.type === 'qwen2' || cfg.type === 'qwen3') pre = 'qwen2';
    else if (pt.includes('\\\\p{N}{1,3}') || pt.includes('\\p{N}{1,3}')) pre = 'llama-bpe';
    else if (pt.includes('"Digits"')) pre = 'smollm';
    out.push(['tokenizer.ggml.pre', GT.STRING, pre]);
    out.push(['tokenizer.ggml.tokens', GT.ARRAY, [GT.STRING, tokens]]);
    out.push(['tokenizer.ggml.token_type', GT.ARRAY, [GT.INT32, types]]);
    const merges = (model.merges || []).map(m => Array.isArray(m) ? m.join(' ') : m);
    out.push(['tokenizer.ggml.merges', GT.ARRAY, [GT.STRING, merges]]);
  } else {
    out.push(['tokenizer.ggml.model', GT.STRING, 'llama']);
    out.push(['tokenizer.ggml.pre', GT.STRING, 'default']);
    for (let i = 0; i < V; i++) if (/^<0x[0-9A-F]{2}>$/.test(tokens[i])) types[i] = 6;
    const unk = id(model.unk_token ?? tcfg.unk_token);
    if (unk != null) types[unk] = 2;
    out.push(['tokenizer.ggml.tokens', GT.ARRAY, [GT.STRING, tokens]]);
    out.push(['tokenizer.ggml.scores', GT.ARRAY, [GT.FLOAT32, tokens.map((_, i) => -i)]]);
    out.push(['tokenizer.ggml.token_type', GT.ARRAY, [GT.INT32, types]]);
    if (unk != null) out.push(['tokenizer.ggml.unknown_token_id', GT.UINT32, unk]);
  }
  const first = (v) => Array.isArray(v) ? v[0] : v;
  const bos = first(hfCfg.bos_token_id) ?? id(tcfg.bos_token);
  const eos = first(genCfg.eos_token_id) ?? first(hfCfg.eos_token_id) ?? id(tcfg.eos_token);
  const pad = id(tcfg.pad_token);
  if (bos != null) out.push(['tokenizer.ggml.bos_token_id', GT.UINT32, bos]);
  if (eos != null) out.push(['tokenizer.ggml.eos_token_id', GT.UINT32, eos]);
  if (pad != null) out.push(['tokenizer.ggml.padding_token_id', GT.UINT32, pad]);
  out.push(['tokenizer.ggml.add_bos_token', GT.BOOL, tcfg.add_bos_token === true]);
  out.push(['tokenizer.ggml.add_eos_token', GT.BOOL, false]);
  if (tcfg.chat_template) out.push(['tokenizer.chat_template', GT.STRING, typeof tcfg.chat_template === 'string' ? tcfg.chat_template : (tcfg.chat_template.find?.(t => t.name === 'default')?.template || '')]);
  return out;
}

// Writes a GGUF file. specs: [{name (HF), shape}] in HF layout ([out, in] or [n]); get(name) -> Float32Array (merged).
export async function writeGGUF(stream, { cfg, hfCfg, tokenizer, specs, get, ftype = 'f16', name = 'model', onProgress }) {
  const arch = ggufArch(cfg);
  const tensors = [];
  for (const s of specs) {
    const gname = ggufName(s.name);
    if (!gname) continue;
    if (s.name === 'lm_head.weight' && cfg.tied) continue;
    const n = s.shape.reduce((a, b) => a * b, 1);
    const is2d = s.shape.length === 2;
    const type = !is2d ? TT.F32 : ftype === 'q8_0' && s.shape[1] % 32 === 0 ? TT.Q8_0 : ftype === 'f32' ? TT.F32 : TT.F16;
    const bytes = type === TT.F32 ? n * 4 : type === TT.F16 ? n * 2 : (n / 32) * 34;
    tensors.push({ hf: s.name, name: gname, dims: [...s.shape].reverse(), type, bytes, n });
  }
  const rs = cfg.ropeScaling;
  let ropeFreqs = null;
  if (rs && (rs.rope_type === 'llama3' || rs.type === 'llama3')) {
    const scaled = invFreq(cfg), base = invFreq({ ...cfg, ropeScaling: null });
    ropeFreqs = Float32Array.from(base, (b, i) => b / scaled[i]);
    tensors.push({ hf: null, name: 'rope_freqs.weight', dims: [ropeFreqs.length], type: TT.F32, bytes: ropeFreqs.length * 4, n: ropeFreqs.length });
  }
  let off = 0;
  for (const t of tensors) { t.offset = off; off += Math.ceil(t.bytes / ALIGN) * ALIGN; }

  const w = new W();
  w.u32(0x46554747); w.u32(3); w.u64(tensors.length);
  const meta = [
    ['general.architecture', GT.STRING, arch],
    ['general.name', GT.STRING, name],
    ['general.file_type', GT.UINT32, ftype === 'q8_0' ? 7 : ftype === 'f32' ? 0 : 1],
    ['general.quantization_version', GT.UINT32, 2],
    ['general.alignment', GT.UINT32, ALIGN],
    [`${arch}.context_length`, GT.UINT32, cfg.maxPos],
    [`${arch}.embedding_length`, GT.UINT32, cfg.D],
    [`${arch}.block_count`, GT.UINT32, cfg.L],
    [`${arch}.feed_forward_length`, GT.UINT32, cfg.I],
    [`${arch}.attention.head_count`, GT.UINT32, cfg.H],
    [`${arch}.attention.head_count_kv`, GT.UINT32, cfg.KVH],
    [`${arch}.attention.layer_norm_rms_epsilon`, GT.FLOAT32, cfg.eps],
    [`${arch}.rope.freq_base`, GT.FLOAT32, cfg.theta],
    [`${arch}.attention.key_length`, GT.UINT32, cfg.hd],
    [`${arch}.attention.value_length`, GT.UINT32, cfg.hd],
  ];
  if (arch === 'llama') { meta.push([`${arch}.rope.dimension_count`, GT.UINT32, cfg.hd]); meta.push([`${arch}.vocab_size`, GT.UINT32, cfg.V]); }
  if (rs && (rs.rope_type === 'linear' || rs.type === 'linear')) { meta.push([`${arch}.rope.scaling.type`, GT.STRING, 'linear']); meta.push([`${arch}.rope.scaling.factor`, GT.FLOAT32, rs.factor]); }
  meta.push(...tokenizer);
  w.u64(meta.length);
  for (const [k, t, v] of meta) kv(w, k, t, v);
  for (const t of tensors) { w.str(t.name); w.u32(t.dims.length); for (const d of t.dims) w.u64(d); w.u32(t.type); w.u64(t.offset); }
  w.pad(ALIGN);
  await stream.write(w.bytes());
  let done = 0;
  for (const t of tensors) {
    let data = t.hf ? await get(t.hf) : ropeFreqs;
    if (arch === 'llama' && /self_attn\.(q|k)_proj\.weight$/.test(t.hf || '')) {
      const isQ = t.hf.includes('q_proj');
      data = permuteQK(data, isQ ? cfg.H : cfg.KVH, t.dims[1], t.dims[0]);
    }
    let bytes;
    if (t.type === TT.F32) bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    else if (t.type === TT.F16) { const h = f32ToF16(data); bytes = new Uint8Array(h.buffer, h.byteOffset, h.byteLength); }
    else bytes = quantQ8_0(data);
    await stream.write(bytes);
    const pad = Math.ceil(t.bytes / ALIGN) * ALIGN - t.bytes;
    if (pad) await stream.write(new Uint8Array(pad));
    onProgress?.(++done / tensors.length);
  }
}
