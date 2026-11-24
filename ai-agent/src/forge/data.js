// Turns dataset rows into token sequences with training labels. labels[t] is the token predicted at position t
// (= ids[t+1]) or -1 when position t is not trained on.

// Accepts common dataset shapes and returns {messages} or {text}.
export function normalizeRow(row) {
  if (!row || typeof row !== 'object') return null;
  if (Array.isArray(row.messages)) return { messages: row.messages.map(m => ({ role: m.role, content: String(m.content ?? '') })) };
  if (Array.isArray(row.conversations)) {
    const map = { human: 'user', user: 'user', gpt: 'assistant', assistant: 'assistant', system: 'system' };
    return { messages: row.conversations.map(m => ({ role: map[m.from || m.role] || 'user', content: String(m.value ?? m.content ?? '') })) };
  }
  if (typeof row.instruction === 'string' && typeof row.output === 'string') {
    const user = row.input ? `${row.instruction}\n\n${row.input}` : row.instruction;
    return { messages: [...(row.system ? [{ role: 'system', content: row.system }] : []), { role: 'user', content: user }, { role: 'assistant', content: row.output }] };
  }
  if (typeof row.prompt === 'string' && typeof (row.completion ?? row.response) === 'string') return { messages: [...(row.system ? [{ role: 'system', content: row.system }] : []), { role: 'user', content: row.prompt }, { role: 'assistant', content: row.completion ?? row.response }] };
  if (typeof row.text === 'string') return { text: row.text };
  return null;
}

const promptMessages = (row) => {
  if (Array.isArray(row.prompt)) return row.prompt;
  const msgs = [];
  if (row.system) msgs.push({ role: 'system', content: row.system });
  msgs.push({ role: 'user', content: String(row.prompt ?? row.question ?? '') });
  return msgs;
};

function labelsFrom(ids, ranges, maxLen) {
  const n = Math.min(ids.length, maxLen);
  const labels = new Int32Array(n).fill(-1);
  for (const [a, b] of ranges) for (let j = Math.max(1, a); j < Math.min(b, n); j++) labels[j - 1] = ids[j];
  return { ids: ids.slice(0, n), labels };
}

// SFT on a chat. completionOnly: train only on assistant turns.
export function chatExample(tok, messages, { seqLen = 1024, completionOnly = true, thinking } = {}) {
  const full = tok.chat(messages, { thinking });
  // Templates include BOS text themselves where the model expects it, so no extra BOS here.
  const ids = tok.encode(full);
  if (!completionOnly) return labelsFrom(ids, [[1, ids.length]], seqLen);
  const ranges = [];
  let stable = true;
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role !== 'assistant') continue;
    const pre = tok.chat(messages.slice(0, i), { addGenerationPrompt: true, thinking });
    const upto = tok.chat(messages.slice(0, i + 1), { thinking });
    if (!full.startsWith(pre) || !full.startsWith(upto)) { stable = false; continue; }
    ranges.push([tok.encode(pre).length, tok.encode(upto).length]);
  }
  if (!ranges.length && !stable) {
    // Template rewrites history (e.g. drops earlier reasoning): train on the final assistant turn only.
    const pre = tok.chat(messages.slice(0, -1), { addGenerationPrompt: true, thinking });
    if (full.startsWith(pre)) ranges.push([tok.encode(pre).length, ids.length]);
    else ranges.push([1, ids.length]);
  }
  return labelsFrom(ids, ranges, seqLen);
}

export function sftExamples(tok, rows, opts = {}) {
  const out = [];
  let skipped = 0;
  for (const r of rows) {
    const n = normalizeRow(r);
    if (!n) { skipped++; continue; }
    const ex = n.messages ? chatExample(tok, n.messages, opts) : labelsFrom(tok.encode(n.text, { bos: tok.addBos }).concat([...tok.eos].slice(0, 1)), [[1, Infinity]], opts.seqLen || 1024);
    if (ex.labels.some(l => l >= 0)) out.push(ex); else skipped++;
  }
  return { examples: out, skipped };
}

// Continued pretraining / from scratch: concatenate texts with EOS and cut into seqLen blocks.
export function textBlocks(tok, rows, { seqLen = 512 } = {}) {
  const eos = [...tok.eos][0];
  const stream = [];
  for (const r of rows) {
    const n = normalizeRow(r);
    const text = n?.text ?? (n?.messages ? tok.chat(n.messages) : null);
    if (!text) continue;
    const ids = tok.encode(text, { bos: tok.addBos });
    for (const id of ids) stream.push(id);
    if (eos != null) stream.push(eos);
  }
  const out = [];
  for (let i = 0; i + 2 <= stream.length; i += seqLen) {
    const ids = stream.slice(i, i + seqLen + 1);
    if (ids.length < 8) break;
    const labels = new Int32Array(ids.length - 1);
    for (let t = 0; t < labels.length; t++) labels[t] = ids[t + 1];
    out.push({ ids: ids.slice(0, -1), labels });
  }
  return { examples: out, tokens: stream.length };
}

// DPO pairs: {prompt, chosen, rejected} → two labeled sequences sharing the prompt.
export function dpoExamples(tok, rows, { seqLen = 1024, thinking } = {}) {
  const out = [];
  let skipped = 0;
  for (const r of rows) {
    if (r.chosen == null || r.rejected == null) { skipped++; continue; }
    const pm = promptMessages(r);
    const text = (c) => typeof c === 'string' ? c : Array.isArray(c) ? c.map(m => m.content).join('\n') : String(c);
    const mk = (resp) => chatExample(tok, [...pm, { role: 'assistant', content: text(resp) }], { seqLen, completionOnly: true, thinking });
    const chosen = mk(r.chosen), rejected = mk(r.rejected);
    if (!chosen.labels.some(l => l >= 0) || !rejected.labels.some(l => l >= 0)) { skipped++; continue; }
    out.push({ chosen, rejected });
  }
  return { examples: out, skipped };
}

// GRPO prompts: {prompt, answer?} → prompt token ids.
export function grpoPrompts(tok, rows, { maxPrompt = 512, thinking } = {}) {
  const out = [];
  for (const r of rows) {
    if (r.prompt == null && r.question == null) continue;
    const s = tok.chat(promptMessages(r), { addGenerationPrompt: true, thinking });
    const ids = tok.encode(s);
    if (ids.length > maxPrompt) continue;
    out.push({ ids, row: r });
  }
  return out;
}

// Seeded shuffling so resumed runs see the same order.
export function rng(seed) { let s = (seed >>> 0) || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }
export function shuffled(n, seed) { const r = rng(seed); const a = Array.from({ length: n }, (_, i) => i); for (let i = n - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
