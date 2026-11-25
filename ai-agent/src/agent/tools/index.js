// Tool registry: built-in tools, domain tools, custom Hub tools (tool.json + tool.js) and MCP tools.
import * as vfs from '../../core/vfs.js';
import { layerDirs } from '../../core/hub.js';
import { fsTools } from './fs.js';
import { execTools } from './exec.js';
import { coreTools } from './core.js';
import { WebFetch, WebSearch } from './web.js';
import { Memory, Recall } from './memory.js';
import { runSandboxed } from '../../runtimes/sandbox.js';
import { sandboxRpc } from '../../shell/host.js';

// Domain tools live in their own modules and are loaded on demand.
const DOMAIN = [
  () => import('./docs.js').then(m => m.docTools),
  () => import('./media.js').then(m => m.mediaTools),
  () => import('./device.js').then(m => m.deviceTools),
  () => import('./studio.js').then(m => m.studioTools),
];

let domainCache = null;
async function domainTools() {
  if (domainCache) return domainCache;
  const out = [];
  for (const load of DOMAIN) { try { out.push(...await load()); } catch (e) { console.warn('tool module failed', e); } }
  return domainCache = out;
}

export async function customTools(cwd) {
  const out = [];
  const seen = new Set();
  for (const { dir, scope } of layerDirs('tools', cwd)) {
    for (const e of await vfs.list(dir, { details: false }).catch(() => [])) {
      if (e.kind !== 'directory') continue;
      const spec = await vfs.readJSON(`${e.path}/tool.json`, null);
      if (!spec?.name || seen.has(spec.name)) continue;
      seen.add(spec.name);
      const codePath = `${e.path}/tool.js`;
      out.push({
        name: spec.name.replace(/[^A-Za-z0-9_-]/g, '_'),
        description: (spec.description || spec.name) + (scope === 'project' ? ' (project tool)' : ''),
        input_schema: spec.input_schema || spec.inputSchema || { type: 'object', properties: {} },
        kind: spec.readOnly ? 'read' : 'exec', readOnly: !!spec.readOnly, custom: true, local: spec.local !== false && !!spec.local, path: e.path,
        key: () => spec.name,
        summary: (i) => JSON.stringify(i).slice(0, 80),
        async run(input, ctx) {
          const code = await vfs.readText(codePath);
          const r = await runSandboxed(code, { mode: 'tool', input, rpc: sandboxRpc(ctx.cwd, { allowNet: !!spec.network }), timeoutMs: (spec.timeout || 60) * 1000 });
          if (r.error) throw new Error(r.error);
          const val = r.result;
          const text = (r.logs?.length ? r.logs.join('\n') + '\n' : '') + (typeof val === 'string' ? val : JSON.stringify(val, null, 2));
          return { content: text || 'Done.' };
        },
      });
    }
  }
  return out;
}

export const CORE_NAMES = ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'LS', 'Bash', 'TodoWrite', 'WebSearch', 'WebFetch', 'AskUser', 'Skill', 'Memory', 'Python', 'ExitPlanMode'];

// Short descriptions for small on-device models (keeps the prompt small so the first turn is fast).
const BRIEF = {
  Read: 'Read a text file (shows numbered lines). Read before editing.',
  Write: 'Create or overwrite a file with content.',
  Edit: 'Replace exact text (old_string) with new_string in a file.',
  Glob: 'Find files by pattern, e.g. "**/*.js".',
  Grep: 'Search file contents with a regex.',
  LS: 'List a folder.',
  Bash: 'Run a shell command (ls, cat, grep, mkdir, mv, python, curl…). / is the Hub, projects in /workspace.',
  Python: 'Run Python code (numpy, pandas, matplotlib available).',
  TodoWrite: 'Set the task list for multi-step work (full list each time).',
  WebSearch: 'Search the web (online only).',
  WebFetch: 'Read a web page as text (online only).',
  AskUser: 'Ask the user a multiple-choice question.',
  Skill: 'Load a skill by name (instructions for a kind of task).',
  Memory: 'Long-term memory: action remember|update|forget|list.',
  ExitPlanMode: 'Present your plan for approval (plan mode).',
};
const slim = (schema) => {
  if (!schema || typeof schema !== 'object') return schema;
  const out = { ...schema };
  delete out.description;
  if (out.properties) out.properties = Object.fromEntries(Object.entries(out.properties).map(([k, v]) => [k, slim(v)]));
  if (out.items) out.items = slim(out.items);
  return out;
};

// All tools available to a session, filtered by mode, profile and the session's allow-list (subagents).
export async function toolsFor(session) {
  const base = [...fsTools, ...execTools, ...coreTools, WebSearch, WebFetch, Memory, Recall];
  let all = [...base, ...await domainTools(), ...await customTools(session.cwd)];
  try { const { mcpTools } = await import('../mcp.js'); all.push(...await mcpTools()); } catch (e) { console.warn(e); }
  const names = new Set();
  all = all.filter(t => !names.has(t.name) && names.add(t.name));
  if (session.mode !== 'plan') all = all.filter(t => !t.planOnly);
  if (session.allowedTools) all = all.filter(t => session.allowedTools.includes(t.name) || (t.name === 'TodoWrite'));
  if (session.depth > 0) all = all.filter(t => t.name !== 'Task' && t.name !== 'AskUser');
  if (session.toolProfile() === 'core') {
    all = all.filter(t => CORE_NAMES.includes(t.name) || (t.custom && t.local) || t.alwaysOn || (session.allowedTools && session.allowedTools.includes(t.name)))
      .map(t => BRIEF[t.name] ? { ...t, description: BRIEF[t.name], input_schema: slim(t.input_schema) } : t);
  }
  return all;
}
