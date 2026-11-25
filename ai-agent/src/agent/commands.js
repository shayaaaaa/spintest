// Slash commands for the Agent and Code chat (built-in + Hub/commands + <project>/.hub/commands).
import * as vfs from '../core/vfs.js';
import { loadMarkdownItems, listProjects, projectRoot } from '../core/hub.js';
import { settings, permissions } from '../core/settings.js';
import { MODES, nextMode } from './permissions.js';
import { modelLabel, chatModels, contextWindow } from '../models/registry.js';
import { fmtNum } from '../core/util.js';
import { bus } from '../core/bus.js';

// Each handler: (session, args, ui) => string | void. `ui` = {openSettings, openModelPicker, openSessions, newSession, print}
export const BUILTIN = [
  { name: 'help', desc: 'Show commands and tips', run: (s, a, ui) => ui.print(helpText()) },
  { name: 'clear', desc: 'Start a fresh conversation (the old one stays in /resume)', run: (s, a, ui) => ui.newSession() },
  { name: 'compact', desc: 'Summarize the conversation to free context. Optional: focus instructions', args: '[instructions]', run: async (s, a, ui) => { ui.print('Compacting…'); await s.compact(a); ui.print('Conversation compacted.'); } },
  { name: 'model', desc: 'Choose the model for this session', args: '[name]', run: (s, a, ui) => {
    if (!a) return ui.openModelPicker();
    const m = chatModels().find(x => x.label.toLowerCase().includes(a.toLowerCase()) || x.ref.includes(a));
    if (!m) return ui.print(`No model matches "${a}".`);
    s.setModel(m.ref); ui.print(`Model set to ${m.label}.`);
  } },
  { name: 'mode', desc: 'Cycle permission mode (ask → accept edits → plan → auto)', args: '[ask|acceptEdits|plan|auto]', run: (s, a, ui) => { const m = MODES.find(x => x.id.toLowerCase() === a.toLowerCase()) ? a : nextMode(s.mode); s.setMode(MODES.find(x => x.id.toLowerCase() === m.toLowerCase()).id); ui.print(`Permission mode: ${MODES.find(x => x.id === s.mode).label}`); } },
  { name: 'plan', desc: 'Switch to plan mode (read-only; the agent proposes a plan)', run: (s, a, ui) => { s.setMode('plan'); ui.print('Plan mode on. The agent will investigate and propose a plan before changing anything.'); if (a) return { send: a }; } },
  { name: 'permissions', desc: 'Show or edit allow/deny rules', run: (s, a, ui) => ui.openSettings('permissions') },
  { name: 'memory', desc: 'Open MEMORY.md (or the project AGENT.md with "project")', args: '[project]', run: async (s, a) => { const p = a === 'project' && projectRoot(s.cwd) ? `${projectRoot(s.cwd)}/AGENT.md` : '/memory/MEMORY.md'; await vfs.ensureFile(p, p.endsWith('AGENT.md') ? '# Project memory\n' : '# Memory\n'); bus.emit('open-file', { path: p }); } },
  { name: 'init', desc: 'Analyze the project and write its AGENT.md', run: (s) => ({ send: `Please analyze this project (${s.cwd}) and create or update ${projectRoot(s.cwd) || s.cwd}/AGENT.md with: what the project is, how it's structured (key files and folders), how to run/test it, and conventions to follow. Keep it under 80 lines.` }) },
  { name: 'review', desc: 'Review the project for bugs', args: '[path]', run: (s, a) => ({ send: `Review ${a || 'this project'} for correctness bugs, security problems and unclear code. Report findings ranked by severity with path:line and suggested fixes.` }) },
  { name: 'cd', desc: 'Change the working folder', args: '<path>', run: async (s, a, ui) => { const p = vfs.normalize(a || '/workspace', s.cwd); if (!(await vfs.isDir(p))) return ui.print(`No folder ${p}`); s.setCwd(p); ui.print(`Working directory: ${p}`); } },
  { name: 'new', desc: 'Create a new project in /workspace and open it', args: '<name>', run: async (s, a, ui) => { const name = (a || 'project-' + Date.now().toString(36)).replace(/[^\w.-]+/g, '-'); const p = `/workspace/${name}`; await vfs.mkdir(p); await vfs.ensureFile(`${p}/AGENT.md`, `# ${name}\n\nDescribe this project here.\n`); s.setCwd(p); ui.print(`Created ${p} and switched to it.`); } },
  { name: 'projects', desc: 'List projects', run: async (s, a, ui) => ui.print((await listProjects()).map(p => (p === projectRoot(s.cwd) ? '› ' : '  ') + p).join('\n') || 'No projects') },
  { name: 'resume', desc: 'Resume an earlier conversation', run: (s, a, ui) => ui.openSessions() },
  { name: 'rewind', desc: 'Undo the last turn: restore changed files and remove it', run: async (s, a, ui) => { const n = await s.rewind(); ui.print(n ? `Restored ${n} file(s) and removed the last turn.` : 'Nothing to rewind.'); } },
  { name: 'todos', desc: 'Show the current task list', run: (s, a, ui) => ui.print(s.s.todos.length ? s.s.todos.map(t => `${t.status === 'completed' ? '☒' : '☐'} ${t.content}`).join('\n') : 'No todos.') },
  { name: 'context', desc: 'Show how full the context window is', run: (s, a, ui) => { const used = s.estimateTokens(); const lim = contextWindow(s.modelRef()); ui.print(`Context: ~${fmtNum(used)} / ${fmtNum(lim)} tokens (${Math.round(used / lim * 100)}%) · ${s.s.messages.length} messages`); } },
  { name: 'cost', desc: 'Show token usage for this session', run: (s, a, ui) => { const u = s.s.usage; ui.print(`Tokens: ${fmtNum(u.input)} in · ${fmtNum(u.output)} out${u.cost ? ` · ≈ $${u.cost.toFixed(4)}` : ''}${u.tps ? ` · last speed ${u.tps.toFixed(1)} tok/s` : ''}`); } },
  { name: 'skills', desc: 'List skills', run: async (s, a, ui) => ui.print((await loadMarkdownItems('skills', s.cwd)).map(x => `• ${x.name}${x.scope === 'project' ? ' (project)' : ''}: ${x.description}`).join('\n') || 'No skills. Ask the agent to create one.') },
  { name: 'agents', desc: 'List subagents', run: async (s, a, ui) => ui.print(['• general: all tools', ...(await loadMarkdownItems('agents', s.cwd)).map(x => `• ${x.name}: ${x.description}`)].join('\n')) },
  { name: 'tools', desc: 'List the tools available to the agent', run: async (s, a, ui) => { const { toolsFor } = await import('./tools/index.js'); const t = await toolsFor(s); ui.print(`${t.length} tools (${s.toolProfile()} profile):\n` + t.map(x => `• ${x.name}${x.custom ? ' (custom)' : ''}`).join('\n')); } },
  { name: 'mcp', desc: 'Show MCP server status', run: async (s, a, ui) => { const { loadMcpConfig, mcpStatus } = await import('./mcp.js'); const cfg = await loadMcpConfig(); const st = mcpStatus(); const names = Object.keys(cfg); ui.print(names.length ? names.map(n => `• ${n}: ${st[n]?.error ? 'error: ' + st[n].error : (st[n]?.tools ?? 0) + ' tools'}`).join('\n') : 'No MCP servers. Add them in Hub → settings/mcp.json or Settings → Connectors.'); } },
  { name: 'hooks', desc: 'Edit hooks', run: () => bus.emit('open-file', { path: '/hooks/hooks.json' }) },
  { name: 'config', desc: 'Open Settings', run: (s, a, ui) => ui.openSettings() },
  { name: 'export', desc: 'Save this conversation as Markdown in the project', run: async (s, a, ui) => { const p = `${s.cwd}/conversation-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.md`; await vfs.write(p, exportMarkdown(s)); ui.print(`Saved ${p}`); } },
  { name: 'status', desc: 'Show model, mode, folder and network', run: (s, a, ui) => ui.print(`Model: ${modelLabel(s.modelRef())}\nMode: ${MODES.find(m => m.id === s.mode)?.label}\nFolder: ${s.cwd}\nNetwork: ${navigator.onLine ? 'online' : 'offline'}\nTool profile: ${s.toolProfile()}\nAllow rules: ${(permissions.get().allow || []).join(', ') || '—'}`) },
];

function helpText() {
  return `Commands:\n${BUILTIN.map(c => `  /${c.name}${c.args ? ' ' + c.args : ''} — ${c.desc}`).join('\n')}\n\nTips:\n  !command    run a shell command directly (no model)\n  #note       save a note to memory\n  @path       attach a file or folder to your message\n  Custom commands: add Markdown files to ~/commands (or <project>/.hub/commands).`;
}

export async function allCommands(cwd) {
  const custom = await loadMarkdownItems('commands', cwd).catch(() => []);
  return [...BUILTIN.map(c => ({ name: c.name, desc: c.desc, args: c.args, builtin: true })), ...custom.map(c => ({ name: c.name, desc: c.data.description || c.description || 'Custom command', args: c.data['argument-hint'] || '', custom: true, scope: c.scope }))];
}

// Returns {handled: true} or {send: text} for the caller to send to the model.
export async function runSlash(session, input, ui) {
  const m = /^\/(\S+)\s*([\s\S]*)$/.exec(input.trim());
  if (!m) return { handled: false };
  const [, name, args] = m;
  const b = BUILTIN.find(c => c.name === name);
  if (b) { const r = await b.run(session, args.trim(), ui); return r?.send ? { send: r.send } : { handled: true }; }
  const custom = (await loadMarkdownItems('commands', session.cwd)).find(c => c.name === name);
  if (custom) return { send: custom.body.replace(/\$ARGUMENTS/g, args.trim()).replace(/\$1/g, args.trim().split(/\s+/)[0] || '') };
  ui.print(`Unknown command /${name}. Type /help.`);
  return { handled: true };
}

export function exportMarkdown(s) {
  const lines = [`# ${s.s.title}`, '', `_${new Date(s.s.created).toLocaleString()} · ${modelLabel(s.modelRef())}_`, ''];
  for (const m of s.s.messages) {
    if (typeof m.content === 'string') { lines.push(`**${m.role === 'user' ? 'You' : 'Agent'}:** ${m.content}`, ''); continue; }
    for (const b of m.content) {
      if (b.type === 'text') lines.push(`**${m.role === 'user' ? 'You' : 'Agent'}:** ${b.text}`, '');
      else if (b.type === 'tool_use') lines.push(`> 🔧 ${b.name}(${JSON.stringify(b.input).slice(0, 200)})`, '');
    }
  }
  return lines.join('\n');
}
