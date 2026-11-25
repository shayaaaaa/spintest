// Tokenizers for Forge: HF tokenizer.json via transformers.js (chat templates included), plus a byte-level BPE
// trainer for models trained from scratch. Works in a worker or on the main thread.
import * as vfs from '../core/vfs.js';

let T = null;
async function tjs() {
  if (T) return T;
  T = await import('../../vendor/transformers.mjs');
  T.env.allowLocalModels = false;
  T.env.allowRemoteModels = false;
  return T;
}

export const CHATML_TEMPLATE = "{% for message in messages %}{{'<|im_start|>' + message['role'] + '\\n' + message['content'] + '<|im_end|>' + '\\n'}}{% endfor %}{% if add_generation_prompt %}{{ '<|im_start|>assistant\\n' }}{% endif %}";

export class Tok {
  constructor(t, { tokenizerJson, tokenizerConfig, config = {}, genConfig = {} }) {
    this.t = t; this.json = tokenizerJson; this.cfg = tokenizerConfig; this.config = config; this.genConfig = genConfig;
    const ids = new Set();
    const add = (v) => { for (const x of [].concat(v ?? [])) if (Number.isInteger(x)) ids.add(x); };
    add(genConfig.eos_token_id); add(config.eos_token_id);
    const tokId = (s) => { const c = typeof s === 'object' ? s?.content : s; if (!c) return null; const id = this.tokenId(c); return id; };
    add(tokId(tokenizerConfig.eos_token));
    for (const s of ['<|im_end|>', '<|eot_id|>', '<|end_of_text|>', '<|endoftext|>', '</s>', '<end_of_turn>', '<|end|>']) { const id = this.tokenId(s); if (id != null && (s !== '<|endoftext|>' || !ids.size)) ids.add(id); }
    this.eos = ids;
    this.bos = Number.isInteger(config.bos_token_id) ? config.bos_token_id : tokId(tokenizerConfig.bos_token);
    this.addBos = tokenizerConfig.add_bos_token === true;
    this.vocabSize = this.size();
  }

  static async fromFiles({ tokenizerJson, tokenizerConfig = {}, chatTemplate, config = {}, genConfig = {} }) {
    const t = await tjs();
    const cfg = { ...tokenizerConfig };
    if (chatTemplate) cfg.chat_template = chatTemplate;
    if (!cfg.chat_template) cfg.chat_template = CHATML_TEMPLATE;
    const cls = t.AutoTokenizer.TOKENIZER_CLASS_MAPPING?.[String(cfg.tokenizer_class || '').replace(/Fast$/, '')] || t.PreTrainedTokenizer;
    const tok = new cls(tokenizerJson, cfg);
    return new Tok(tok, { tokenizerJson, tokenizerConfig: cfg, config, genConfig });
  }

  static async fromDir(dir) {
    const read = (f) => vfs.readJSON(`${dir}/${f}`, null);
    const tokenizerJson = await read('tokenizer.json');
    if (!tokenizerJson) throw new Error(`${dir} has no tokenizer.json`);
    const chatTemplate = await vfs.readText(`${dir}/chat_template.jinja`).catch(() => null);
    return Tok.fromFiles({ tokenizerJson, tokenizerConfig: (await read('tokenizer_config.json')) || {}, chatTemplate, config: (await read('config.json')) || {}, genConfig: (await read('generation_config.json')) || {} });
  }

  size() {
    const v = this.json?.model?.vocab;
    let n = v ? (Array.isArray(v) ? v.length : Object.keys(v).length) : 0;
    for (const a of this.json?.added_tokens || []) n = Math.max(n, a.id + 1);
    return n;
  }
  tokenId(s) {
    for (const a of this.json?.added_tokens || []) if (a.content === s) return a.id;
    const v = this.json?.model?.vocab;
    if (v && !Array.isArray(v) && v[s] != null) return v[s];
    return null;
  }

  encode(text, { bos = false } = {}) {
    const ids = Array.from(this.t.encode(text, { add_special_tokens: false }));
    if (bos && this.bos != null) ids.unshift(this.bos);
    return ids;
  }
  decode(ids, { skipSpecial = false } = {}) { return ids?.length ? this.t.decode(Array.from(ids), { skip_special_tokens: skipSpecial }) : ''; }

  // Renders a chat with the model's template. messages: [{role, content}].
  chat(messages, { addGenerationPrompt = false, tools, thinking } = {}) {
    const kw = { tokenize: false, add_generation_prompt: addGenerationPrompt };
    if (tools?.length) kw.tools = tools;
    if (thinking != null) kw.enable_thinking = thinking;
    return this.t.apply_chat_template(messages, kw);
  }
  hasTemplate() { return !!this.cfg.chat_template; }
}

// Incremental detokenizer: emits only complete characters.
export class StreamDecoder {
  constructor(tok) { this.tok = tok; this.ids = []; this.sent = ''; }
  push(id) {
    this.ids.push(id);
    const text = this.tok.decode(this.ids);
    if (text.endsWith('�')) return '';
    const d = text.slice(this.sent.length);
    this.sent = text;
    return d;
  }
}

// ---------- byte-level BPE trainer ----------
function bytesToUnicode() {
  const bs = [];
  for (let i = 33; i <= 126; i++) bs.push(i);
  for (let i = 161; i <= 172; i++) bs.push(i);
  for (let i = 174; i <= 255; i++) bs.push(i);
  const cs = [...bs];
  let n = 0;
  for (let b = 0; b < 256; b++) if (!bs.includes(b)) { bs.push(b); cs.push(256 + n); n++; }
  const m = new Array(256);
  bs.forEach((b, i) => { m[b] = String.fromCharCode(cs[i]); });
  return m;
}
const GPT2_SPLIT = /'s|'t|'re|'ve|'m|'ll|'d| ?\p{L}+| ?\p{N}+| ?[^\s\p{L}\p{N}]+|\s+(?!\S)|\s+/gu;

// Max-heap keyed by count for lazy best-pair lookup.
class Heap {
  constructor() { this.a = []; }
  push(c, k) { const a = this.a; a.push([c, k]); let i = a.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (a[p][0] > a[i][0] || (a[p][0] === a[i][0] && a[p][1] <= a[i][1])) break; [a[p], a[i]] = [a[i], a[p]]; i = p; } }
  pop() { const a = this.a; const top = a[0]; const last = a.pop(); if (a.length) { a[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; const better = (x, y) => a[x][0] > a[y][0] || (a[x][0] === a[y][0] && a[x][1] < a[y][1]); if (l < a.length && better(l, m)) m = l; if (r < a.length && better(r, m)) m = r; if (m === i) break; [a[m], a[i]] = [a[i], a[m]]; i = m; } } return top; }
  get size() { return this.a.length; }
}

// texts: iterable of strings. Returns {tokenizerJson, tokenizerConfig}. onProgress(fraction).
export async function trainBPE(texts, { vocabSize = 8192, specials = ['<|endoftext|>', '<|im_start|>', '<|im_end|>', '<|pad|>'], maxChars = 30e6, onProgress } = {}) {
  const b2u = bytesToUnicode();
  const enc = new TextEncoder();
  const wordFreq = new Map();
  let chars = 0;
  for (const text of texts) {
    if (chars > maxChars) break;
    chars += text.length;
    for (const m of text.matchAll(GPT2_SPLIT)) wordFreq.set(m[0], (wordFreq.get(m[0]) || 0) + 1);
  }
  // Symbols: ids 0..255 are bytes (in byte order); merges append new symbols.
  const symStr = Array.from({ length: 256 }, (_, b) => b2u[b]);
  const words = [], freqs = [];
  for (const [w, f] of wordFreq) { words.push(Array.from(enc.encode(w))); freqs.push(f); }
  const key = (a, b) => a * 1048576 + b;
  const pairCount = new Map(), pairWords = new Map();
  const addPair = (k, f, wi) => { pairCount.set(k, (pairCount.get(k) || 0) + f); if (wi != null) { let s = pairWords.get(k); if (!s) pairWords.set(k, s = new Set()); s.add(wi); } };
  for (let wi = 0; wi < words.length; wi++) { const w = words[wi]; for (let i = 0; i + 1 < w.length; i++) addPair(key(w[i], w[i + 1]), freqs[wi], wi); }
  const heap = new Heap();
  for (const [k, c] of pairCount) heap.push(c, k);
  const merges = [];
  const target = Math.max(0, vocabSize - specials.length - 256);
  let lastYield = Date.now();
  while (merges.length < target && heap.size) {
    const [c, k] = heap.pop();
    if (pairCount.get(k) !== c) continue; // stale heap entry
    if (c < 2) break;
    const a = Math.floor(k / 1048576), b = k % 1048576;
    const nid = symStr.length;
    symStr.push(symStr[a] + symStr[b]);
    merges.push([a, b]);
    const touched = new Map();
    for (const wi of pairWords.get(k) || []) {
      const w = words[wi], f = freqs[wi];
      // remove old pairs
      for (let i = 0; i + 1 < w.length; i++) { const pk = key(w[i], w[i + 1]); pairCount.set(pk, pairCount.get(pk) - f); touched.set(pk, 1); }
      const nw = [];
      for (let i = 0; i < w.length; i++) { if (i + 1 < w.length && w[i] === a && w[i + 1] === b) { nw.push(nid); i++; } else nw.push(w[i]); }
      words[wi] = nw;
      for (let i = 0; i + 1 < nw.length; i++) { const pk = key(nw[i], nw[i + 1]); addPair(pk, f, wi); touched.set(pk, 1); }
    }
    pairWords.delete(k); pairCount.delete(k);
    for (const pk of touched.keys()) { const cc = pairCount.get(pk); if (cc > 0) heap.push(cc, pk); }
    if (Date.now() - lastYield > 200) { onProgress?.(merges.length / target); await new Promise(r => setTimeout(r, 0)); lastYield = Date.now(); }
  }
  const vocab = {};
  specials.forEach((s, i) => { vocab[s] = i; });
  symStr.forEach((s, i) => { vocab[s] = specials.length + i; });
  const tokenizerJson = {
    version: '1.0', truncation: null, padding: null,
    added_tokens: specials.map((s, i) => ({ id: i, content: s, single_word: false, lstrip: false, rstrip: false, normalized: false, special: true })),
    normalizer: null,
    pre_tokenizer: { type: 'ByteLevel', add_prefix_space: false, trim_offsets: true, use_regex: true },
    post_processor: { type: 'ByteLevel', add_prefix_space: true, trim_offsets: false, use_regex: true },
    decoder: { type: 'ByteLevel', add_prefix_space: true, trim_offsets: true, use_regex: true },
    model: { type: 'BPE', dropout: null, unk_token: null, continuing_subword_prefix: null, end_of_word_suffix: null, fuse_unk: false, byte_fallback: false, ignore_merges: false, vocab, merges: merges.map(([a, b]) => `${symStr[a]} ${symStr[b]}`) },
  };
  const tokenizerConfig = {
    tokenizer_class: 'GPT2Tokenizer', add_bos_token: false, add_prefix_space: false, clean_up_tokenization_spaces: false,
    bos_token: null, eos_token: '<|im_end|>', pad_token: '<|pad|>', unk_token: null, model_max_length: 4096,
    chat_template: CHATML_TEMPLATE,
    added_tokens_decoder: Object.fromEntries(specials.map((s, i) => [String(i), { content: s, lstrip: false, normalized: false, rstrip: false, single_word: false, special: true }])),
  };
  onProgress?.(1);
  return { tokenizerJson, tokenizerConfig, vocabSize: specials.length + symStr.length };
}
