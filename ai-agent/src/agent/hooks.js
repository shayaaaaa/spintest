// Hooks: user JavaScript that runs (sandboxed) on agent events. Config in Hub/hooks/hooks.json and
// <project>/.hub/hooks.json: { "PreToolUse": [{ "matcher": "Bash|Write", "code": "if (event.input.command.includes('rm -rf')) return {decision:'block', reason:'no'}" }] }
import * as vfs from '../core/vfs.js';
import { projectRoot } from '../core/hub.js';
import { runSandboxed } from '../runtimes/sandbox.js';

async function loadHooks(cwd) {
  const files = ['/hooks/hooks.json'];
  const root = projectRoot(cwd);
  if (root) files.push(`${root}/.hub/hooks.json`);
  const merged = {};
  for (const f of files) {
    const j = await vfs.readJSON(f, null);
    if (!j) continue;
    for (const [ev, list] of Object.entries(j)) if (Array.isArray(list)) (merged[ev] ||= []).push(...list);
  }
  return merged;
}

// Returns {block: reason|null, messages: [string]}.
export async function runHooks(eventName, event, { cwd }) {
  const hooks = (await loadHooks(cwd))[eventName] || [];
  const res = { block: null, messages: [] };
  for (const h of hooks) {
    if (h.enabled === false || !h.code) continue;
    if (h.matcher && event.tool && !new RegExp('^(' + h.matcher + ')$').test(event.tool)) continue;
    const r = await runSandboxed(h.code, { mode: 'hook', input: event, timeoutMs: 10000 });
    if (r.error) { res.messages.push(`Hook error (${eventName}): ${r.error.split('\n')[0]}`); continue; }
    const out = r.result;
    if (out?.decision === 'block') { res.block = out.reason || 'Blocked by a hook'; break; }
    if (out?.message) res.messages.push(String(out.message));
    for (const l of r.logs || []) res.messages.push(l);
  }
  return res;
}
