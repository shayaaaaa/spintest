// Builds the agent's system prompt: identity, environment, rules, memory, project memory, skills and subagents.
import * as vfs from '../core/vfs.js';
import { loadMarkdownItems, projectMemory, projectRoot } from '../core/hub.js';
import { truncate } from '../core/util.js';

async function projectSnapshot(cwd, max = 40) {
  try {
    const items = await vfs.list(cwd);
    const lines = items.filter(e => !e.name.startsWith('.') || e.name === '.hub').slice(0, max).map(e => `- ${e.name}${e.kind === 'directory' ? '/' : ''}`);
    return lines.join('\n') + (items.length > max ? `\n- … ${items.length - max} more` : '');
  } catch { return '(folder not found)'; }
}

export async function buildSystemPrompt(session, { compact = false } = {}) {
  const cwd = session.cwd;
  const now = new Date();
  const online = navigator.onLine;
  const [memory, proj, skills, agents, snap] = await Promise.all([
    vfs.readText('/memory/MEMORY.md').catch(() => ''),
    projectMemory(cwd),
    loadMarkdownItems('skills', cwd),
    loadMarkdownItems('agents', cwd),
    projectSnapshot(cwd, compact ? 25 : 60),
  ]);
  const parts = [];
  parts.push(`You are Ai Agent, an autonomous AI agent that runs on the user's phone (an iPhone Duo foldable) inside a sandboxed workspace called the Hub. You help with software engineering, research, writing, files and documents, data analysis, and training AI models on the device. You work by calling tools, then reporting back concisely.`);
  parts.push(`# Environment
- Working directory: ${cwd}${projectRoot(cwd) ? ` (project "${projectRoot(cwd).split('/').pop()}")` : ''}
- Hub root is "/" (also "~"): /workspace (projects), /memory, /skills, /tools, /agents, /knowledge, /datasets, /models, /training, /settings
- Date: ${now.toLocaleString(undefined, { dateStyle: 'full', timeStyle: 'short' })}
- Network: ${online ? 'online' : 'OFFLINE (web tools will fail; work with local files and your own knowledge)'}
- Permission mode: ${session.mode}
- Shell: jsh (POSIX-like, runs in the browser). Python 3.13 via the Python tool. No npm/pip from PyPI; use plain ES modules and the bundled Python packages.
Top level of the working directory:
${snap}`);
  if (compact) parts.push(`# How to work
- Be concise. Act with tools instead of describing what you would do.
- Explore with LS/Glob/Grep/Read; change files with Edit/Write (Read first). Never invent file contents or results.
- Multi-step work: keep a TodoWrite list. Verify changes by running them when practical.
- When finished, summarize what changed in 1–3 lines.`);
  else parts.push(`# How to work
- Be concise and direct. Do the task instead of describing what you would do. No long preambles.
- Use tools to look before you act: Glob/Grep/LS/Read to explore, then Edit/Write to change. Read a file before editing it. Prefer Edit (exact replacement) over rewriting whole files.
- For tasks with 3+ steps, keep a TodoWrite list and update it as you go (one item in_progress at a time).
- Never invent file contents, paths, command output or facts. If something fails, read the error and fix it.
- After changing code, verify it (run it with Bash/Python/RunJS, or re-read the result) when practical.
- Ask with AskUser only when a decision is genuinely the user's; otherwise pick a sensible default and say so.
- Before destructive actions (deleting many files, overwriting work) make sure the user wants it.
- When you reference code, use path:line. When you finish, summarize what changed in 1–4 lines.
- Use Memory to save durable facts the user tells you to remember (or that clearly matter later). Use Recall to search memory and the knowledge base.`);
  if (session.mode === 'plan') parts.push(`# Plan mode is ON
Do not modify files or run commands that change anything. Investigate with read-only tools, then call ExitPlanMode with a concise, numbered plan (approach, files to change, steps, risks). Wait for approval.`);
  if (memory.trim()) parts.push(`# User memory (from ~/memory/MEMORY.md, always loaded)\n${truncate(memory.trim(), compact ? 2500 : 8000)}`);
  if (proj?.text?.trim()) parts.push(`# Project memory (${proj.path})\n${truncate(proj.text.trim(), compact ? 3000 : 12000)}`);
  if (skills.length) parts.push(`# Skills
Load a skill with the Skill tool when the task matches its description, then follow it.
${skills.map(s => `- ${s.name}: ${truncate(s.description, compact ? 140 : 300)}`).join('\n')}`);
  if (agents.length && session.depth === 0 && !compact) parts.push(`# Subagents (use with the Task tool for self-contained work)
- general: a general-purpose agent with all tools
${agents.map(a => `- ${a.name}: ${truncate(a.description, 200)}`).join('\n')}`);
  if (session.extraSystem) parts.push(session.extraSystem);
  return parts.join('\n\n');
}
