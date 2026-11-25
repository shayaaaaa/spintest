// Permission modes and rules (Claude Code style).
// Modes: ask (approve edits/commands), acceptEdits (file edits auto-approved), plan (read-only, propose a plan), auto (no prompts).
// Rules: "Read", "Bash(npm test:*)", "Edit(/workspace/**)", "WebFetch(domain:example.com)". deny > ask > allow.
import { permissions } from '../core/settings.js';
import { globToRegExp } from '../core/util.js';

export const MODES = [
  { id: 'ask', label: 'Ask before edits', short: 'ask', color: 'var(--text-3)', hint: 'Approve each file change and command' },
  { id: 'acceptEdits', label: 'Accept edits', short: 'accept edits', color: 'var(--accent)', hint: 'File edits are approved automatically; commands still ask' },
  { id: 'plan', label: 'Plan mode', short: 'plan', color: 'var(--info)', hint: 'Read-only: the agent investigates and proposes a plan' },
  { id: 'auto', label: 'Auto', short: 'auto', color: 'var(--warn)', hint: 'No prompts. The agent can change or delete files without asking' },
];
export const nextMode = (m) => MODES[(MODES.findIndex(x => x.id === m) + 1) % MODES.length].id;

function parseRule(r) {
  const m = /^([A-Za-z0-9_\-:.]+)(?:\((.*)\))?$/.exec(String(r).trim());
  return m ? { tool: m[1], pattern: m[2] ?? null } : null;
}

function ruleMatches(rule, tool, key) {
  const r = parseRule(rule);
  if (!r || (r.tool !== tool.name && r.tool !== '*')) return false;
  if (r.pattern == null || r.pattern === '' || r.pattern === '*') return true;
  if (key == null) return false;
  if (r.pattern.endsWith(':*')) return String(key).startsWith(r.pattern.slice(0, -2));
  if (r.pattern.startsWith('domain:')) return String(key) === r.pattern || String(key).endsWith('.' + r.pattern.slice(7)) && String(key).startsWith('domain:');
  if (/[*?]/.test(r.pattern)) return globToRegExp(r.pattern.replace(/^~/, '')).test(String(key));
  return String(key) === r.pattern;
}

// Returns 'allow' | 'ask' | 'deny' (+ reason).
export function decide(tool, input, { mode, sessionAllow = [], cwd }) {
  const p = permissions.get();
  const key = tool.key ? tool.key(input) : null;
  const any = (list) => (list || []).some(r => ruleMatches(r, tool, key));
  if (any(p.deny)) return { decision: 'deny', reason: 'Blocked by a deny rule in Settings → Permissions.' };
  if (mode === 'plan' && !tool.readOnly && !tool.planOnly) return { decision: 'deny', reason: 'Plan mode is on: only read-only tools are allowed. Investigate, then present a plan with ExitPlanMode.' };
  if (tool.planOnly && mode !== 'plan') return { decision: 'deny', reason: 'ExitPlanMode is only used in plan mode.' };
  if (any(p.ask)) return { decision: 'ask' };
  if (mode === 'auto') return { decision: 'allow' };
  if (any(p.allow) || any(sessionAllow)) return { decision: 'allow' };
  if (tool.readOnly && tool.kind !== 'network') return { decision: 'allow' };
  if (tool.kind === 'network' && tool.readOnly && mode === 'acceptEdits') return { decision: 'allow' };
  if (mode === 'acceptEdits' && (tool.kind === 'edit')) return { decision: 'allow' };
  if (tool.memory && mode !== 'ask') return { decision: 'allow' };
  return { decision: 'ask' };
}

// The rule added when the user taps "Yes, and don't ask again".
export function ruleFor(tool, input) {
  const key = tool.key ? tool.key(input) : null;
  if (tool.name === 'Bash' && key) { const first = String(key).trim().split(/\s+/)[0]; return `Bash(${first}:*)`; }
  if (tool.kind === 'network' && key?.startsWith('domain:')) return `${tool.name}(${key})`;
  if (tool.kind === 'edit') return tool.name;
  return tool.name;
}

export function addRule(list, rule) {
  permissions.set(p => ({ ...p, [list]: [...new Set([...(p[list] || []), rule])] }));
}
export function removeRule(list, rule) {
  permissions.set(p => ({ ...p, [list]: (p[list] || []).filter(r => r !== rule) }));
}
