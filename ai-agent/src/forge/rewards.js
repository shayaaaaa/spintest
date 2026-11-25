// Built-in GRPO reward functions: (completion, row) -> number. Custom JS rewards run in the app sandbox instead.
const stripThink = (s) => String(s).replace(/<think>[\s\S]*?<\/think>/g, '').trim();
const norm = (s) => String(s ?? '').toLowerCase().replace(/\s+/g, ' ').replace(/[.。!]+$/, '').trim();

// Pulls the final answer from \boxed{…}, "Answer: …", "#### …", or the last non-empty line.
export function finalAnswer(text) {
  const t = stripThink(text);
  const boxed = [...t.matchAll(/\\boxed\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}/g)].pop();
  if (boxed) return boxed[1];
  const ans = [...t.matchAll(/(?:final answer|answer)\s*[:：]\s*(.+)/gi)].pop();
  if (ans) return ans[1];
  const hash = [...t.matchAll(/####\s*(.+)/g)].pop();
  if (hash) return hash[1];
  return t.split('\n').map(l => l.trim()).filter(Boolean).pop() || '';
}
const lastNumber = (s) => { const m = String(s).replace(/,(?=\d{3}\b)/g, '').match(/-?\d+(?:\.\d+)?(?:\/\d+)?/g); if (!m) return null; const x = m[m.length - 1]; if (x.includes('/')) { const [a, b] = x.split('/').map(Number); return b ? a / b : null; } return Number(x); };

export const REWARDS = {
  exact: { label: 'Exact answer', describe: 'Final answer equals the row\'s answer (case/space-insensitive).', fn: (c, r) => norm(finalAnswer(c)) === norm(r.answer) ? 1 : 0 },
  contains: { label: 'Contains answer', describe: 'Completion mentions the answer anywhere.', fn: (c, r) => norm(stripThink(c)).includes(norm(r.answer)) ? 1 : 0 },
  numeric: { label: 'Numeric match', describe: 'Last number in the final answer equals the answer\'s number. For math.', fn: (c, r) => { const a = lastNumber(finalAnswer(c)) ?? lastNumber(stripThink(c)), b = lastNumber(r.answer); return a != null && b != null && Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(b)) ? 1 : 0; } },
  regex: { label: 'Regex', describe: 'Completion matches the row\'s answer (or the configured pattern) as a regular expression.', fn: (c, r, cfg) => { try { return new RegExp(cfg?.pattern || r.pattern || r.answer, 'i').test(stripThink(c)) ? 1 : 0; } catch { return 0; } } },
  format: { label: 'Reasoning format', describe: 'Has <think>…</think> followed by a non-empty answer.', fn: (c) => /^\s*<think>[\s\S]+?<\/think>\s*\S[\s\S]*$/.test(c) ? 1 : 0 },
  length: { label: 'Target length', describe: 'Closer to the target length (cfg.target words, default 100) scores higher.', fn: (c, r, cfg) => { const n = stripThink(c).split(/\s+/).filter(Boolean).length; const t = cfg?.target || r.target || 100; return Math.max(0, 1 - Math.abs(n - t) / t); } },
  json: { label: 'Valid JSON', describe: 'Final answer parses as JSON.', fn: (c) => { const t = stripThink(c).replace(/^```(?:json)?|```$/g, '').trim(); try { JSON.parse(t); return 1; } catch { return 0; } } },
  math: { label: 'Math (numeric + format)', describe: 'numeric match plus 0.2 for clean formatting.', fn: (c, r) => REWARDS.numeric.fn(c, r) + 0.2 * (/(\\boxed\{|answer\s*[:：]|####)/i.test(stripThink(c)) ? 1 : 0) },
};

// Scores completions with a list of {name, weight} built-ins. Returns numbers.
export function scoreBuiltin(spec, completions, row, cfg = {}) {
  const list = (Array.isArray(spec) ? spec : String(spec || 'exact').split('+')).map(s => typeof s === 'string' ? { name: s.trim(), weight: 1 } : s);
  return completions.map(c => list.reduce((sum, { name, weight = 1 }) => sum + weight * (REWARDS[name]?.fn(c, row, cfg) ?? 0), 0));
}
export const isBuiltin = (spec) => (Array.isArray(spec) ? spec.map(s => s.name || s) : String(spec || 'exact').split('+')).every(n => REWARDS[String(n).trim()]);
