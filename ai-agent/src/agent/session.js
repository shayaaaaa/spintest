// Agent session: conversation state + the agent loop (model → tools → model …), Claude Code style.
import * as vfs from '../core/vfs.js';
import { createStore } from '../core/store.js';
import { settings } from '../core/settings.js';
import { uid, estimateTokens, clip, parseFrontMatter } from '../core/util.js';
import { chat, modelFor, contextWindow, parseRef, modelLabel } from '../models/registry.js';
import { blocks, textOf, coerceInput, validateInput, toolResultText } from '../models/content.js';
import { PROVIDERS } from '../models/providers.js';
import { toolsFor } from './tools/index.js';
import { decide, ruleFor, addRule } from './permissions.js';
import { buildSystemPrompt } from './context.js';
import { runHooks } from './hooks.js';
import { loadMarkdownItems } from '../core/hub.js';

export const sessionsIndex = createStore({ list: [] }); // [{id, kind, title, updated, cwd}]

const RUNNING_WORDS = ['Thinking', 'Working', 'Pondering', 'Reasoning', 'Crafting', 'Computing', 'Brewing', 'Tinkering', 'Mulling', 'Assembling', 'Untangling', 'Exploring'];

export class Session {
  constructor(init = {}) {
    this.id = init.id || uid('s_');
    this.kind = init.kind || 'agent';           // agent | chat | code | sub
    this.depth = init.depth || 0;
    this.parent = init.parent || null;
    this.allowedTools = init.allowedTools || null;
    this.extraSystem = init.extraSystem || '';
    this.readFiles = new Map();
    this.checkpoints = [];
    this.shell = null;
    this.sessionAllow = [];
    this.queue = [];
    this.abort = null;
    this.store = createStore({
      id: this.id, kind: this.kind,
      title: init.title || 'New session',
      cwd: init.cwd || settings.get().lastProject || '/workspace/welcome',
      model: init.model || '',
      mode: init.mode || (this.kind === 'agent' || this.kind === 'code' ? (settings.get().agent?.defaultMode || 'ask') : 'auto'),
      messages: init.messages || [],
      todos: init.todos || [],
      usage: init.usage || { input: 0, output: 0, cost: 0 },
      created: init.created || Date.now(),
      updated: init.updated || Date.now(),
      status: 'idle',        // idle | running | waiting
      live: null,            // {text, thinking, calls:[{id,name,partial}], status, word, started}
      toolRuns: init.toolRuns || {},
      pending: null,         // {type:'permission'|'question'|'plan', …, resolve}
      error: null,
      notices: init.notices || [],   // [{at: messageIndex, text, kind}]
      persona: init.persona || null,
      queued: [],
    });
  }

  get s() { return this.store.get(); }
  get cwd() { return this.s.cwd; }
  get mode() { return this.s.mode; }
  get messages() { return this.s.messages; }
  set(patch) { this.store.set(patch); }

  modelRef() { return this.s.model || modelFor(this.kind === 'sub' ? 'subagent' : this.kind === 'code' ? 'code' : this.kind === 'chat' ? 'chat' : 'agent'); }
  isLocal() { return parseRef(this.modelRef())?.type === 'local'; }
  toolProfile() { const p = settings.get().agent?.toolProfile || 'auto'; return p === 'auto' ? (this.isLocal() ? 'core' : 'full') : p; }

  parentOrSelf() { return this.depth ? this.parent : this; }
  markRead(path, mtime) { this.readFiles.set(path, mtime || Date.now()); }
  setTodos(todos) { this.set({ todos }); }
  setCwd(cwd) { this.set({ cwd }); if (this.shell) this.shell.cwd = cwd; if (this.kind !== 'sub') settings.set(s => ({ ...s, lastProject: cwd })); }
  setMode(mode) { this.set({ mode }); }
  setModel(model) { this.set({ model }); }
  notice(text, kind = 'info') { this.set(s => ({ ...s, notices: [...s.notices, { at: s.messages.length, text, kind, t: Date.now() }] })); }

  // ---------- persistence ----------
  path() { return `/chats/${this.id}.json`; }
  async save() {
    if (this.kind === 'sub') return;
    const s = this.s;
    if (!s.messages.length) return;
    const data = { id: this.id, kind: this.kind, title: s.title, cwd: s.cwd, model: s.model, mode: s.mode, created: s.created, updated: Date.now(), messages: s.messages, todos: s.todos, usage: s.usage, notices: s.notices.slice(-50), persona: s.persona, toolRuns: slimRuns(s.toolRuns) };
    await vfs.writeJSON(this.path(), data, { silent: true });
    upsertIndex({ id: this.id, kind: this.kind, title: s.title, updated: data.updated, cwd: s.cwd, model: s.model });
  }
  static async load(id) {
    const d = await vfs.readJSON(`/chats/${id}.json`);
    return new Session(d);
  }

  // ---------- user input ----------
  async send(text, { attachments = [] } = {}) {
    text = String(text || '');
    if (this.s.status !== 'idle') {
      this.queue.push({ text, attachments });
      this.set(s => ({ ...s, queued: [...s.queued, text] }));
      return;
    }
    const content = [...attachments];
    const expanded = await expandMentions(text, this.cwd);
    if (expanded.files.length) content.unshift(...expanded.files.map(f => ({ type: 'text', text: `<file path="${f.path}">\n${f.text}\n</file>` })));
    if (text) content.push({ type: 'text', text });
    const hook = await runHooks('UserPromptSubmit', { prompt: text, cwd: this.cwd }, { cwd: this.cwd }).catch(() => ({ messages: [] }));
    if (hook.block) { this.notice('Prompt blocked by a hook: ' + hook.block, 'err'); return; }
    for (const m of hook.messages) content.push({ type: 'text', text: `<hook-context>${m}</hook-context>` });
    this.push({ role: 'user', content: content.length === 1 && content[0].type === 'text' ? content[0].text : content });
    if (this.s.title === 'New session' && text) this.set({ title: titleFrom(text) });
    this.checkpoints.push({ at: this.s.messages.length - 1, files: new Map() });
    return this.loop();
  }

  push(msg) { this.set(s => ({ ...s, messages: [...s.messages, msg], updated: Date.now() })); }

  stop() { this.abort?.abort(); const p = this.s.pending; if (p) { p.resolve?.(null); this.set({ pending: null }); } }

  // ---------- the loop ----------
  async loop() {
    const ref = this.modelRef();
    if (!ref) { this.set({ error: 'No model available. Download a model in Studio → Models (Qwen3 4B is a good start) or add a cloud API key in Settings.' }); return; }
    this.abort = new AbortController();
    const signal = this.abort.signal;
    const maxTurns = settings.get().agent?.maxTurns || 60;
    this.set({ status: 'running', error: null });
    let turns = 0;
    try {
      while (!signal.aborted) {
        if (++turns > maxTurns) { this.notice(`Stopped after ${maxTurns} steps (Settings → Agent → Max steps).`, 'warn'); break; }
        let tools = await toolsFor(this);
        const pref = parseRef(ref);
        const nativeSearch = pref?.type === 'cloud' && PROVIDERS[pref.provider]?.kind === 'anthropic' && navigator.onLine && ['auto', 'cloud'].includes(settings.get().web?.mode || 'auto') && (this.allowedTools ? this.allowedTools.includes('WebSearch') : true);
        if (nativeSearch) tools = tools.filter(t => t.name !== 'WebSearch');
        const system = await buildSystemPrompt(this, { compact: this.isLocal() });
        await this.maybeCompact(ref, system, tools);
        const word = RUNNING_WORDS[Math.floor(Math.random() * RUNNING_WORDS.length)];
        this.set({ live: { text: '', thinking: '', calls: [], status: '', word, started: Date.now() } });
        const onEvent = (e) => this.onModelEvent(e);
        const agentCfg = settings.get().agent || {};
        const res = await chat(ref, {
          system, messages: this.messagesForModel(), tools: tools.map(t => ({ name: t.name, description: t.description, input_schema: t.input_schema })),
          signal, onEvent, thinking: agentCfg.thinking || 'auto', effort: agentCfg.effort, webSearch: nativeSearch,
          maxTokens: this.isLocal() ? (agentCfg.maxTokens || 2048) : undefined, temperature: agentCfg.temperature,
        });
        this.addUsage(ref, res.usage);
        const content = res.content.filter(b => !(b.type === 'text' && !b.text.trim()));
        this.set({ live: null });
        if (!content.length) content.push({ type: 'text', text: res.stopReason === 'max_tokens' ? '(The response hit the token limit.)' : '(No response.)' });
        this.push({ role: 'assistant', content, _model: ref, _ms: res.ms });
        if (res.stopReason === 'refusal') { this.notice('The model declined this request.', 'warn'); break; }
        const calls = content.filter(b => b.type === 'tool_use');
        if (!calls.length || res.stopReason === 'max_tokens' && calls.some(c => c.input?._invalid_json)) {
          if (this.queue.length) { this.flushQueue(); continue; }
          break;
        }
        const results = await this.runTools(calls, tools, signal);
        if (results === 'interrupted') break;
        const extra = [];
        if (this.queue.length) { for (const q of this.queue) extra.push({ type: 'text', text: q.text }, ...(q.attachments || [])); this.queue = []; this.set({ queued: [] }); }
        this.push({ role: 'user', content: [...results, ...extra] });
        if (results.some(r => r._denied && !r._feedback)) break;
      }
      if (signal.aborted) this.markInterrupted();
      const stop = await runHooks('Stop', { session: this.id, cwd: this.cwd }, { cwd: this.cwd }).catch(() => null);
      for (const m of stop?.messages || []) this.notice(m);
    } catch (e) {
      if (e?.name === 'AbortError' || signal.aborted) this.markInterrupted();
      else { console.error(e); this.set({ error: String(e?.message || e) }); }
    } finally {
      this.abort = null;
      this.set({ status: 'idle', live: null, pending: null });
      this.save().catch(console.error);
      if (this.queue.length && !signal.aborted) { const q = this.queue.shift(); this.set(s => ({ ...s, queued: s.queued.slice(1) })); this.send(q.text, { attachments: q.attachments }); }
    }
  }

  flushQueue() {
    const items = this.queue; this.queue = []; this.set({ queued: [] });
    this.push({ role: 'user', content: items.flatMap(q => [...(q.attachments || []), { type: 'text', text: q.text }]) });
  }

  markInterrupted() {
    const last = this.s.messages[this.s.messages.length - 1];
    // Any tool_use without a result gets a cancelled result, so the conversation stays valid.
    if (last?.role === 'assistant') {
      const calls = blocks(last.content).filter(b => b.type === 'tool_use');
      if (calls.length) this.push({ role: 'user', content: calls.map(c => ({ type: 'tool_result', tool_use_id: c.id, content: 'Cancelled by the user.', is_error: true })) });
    }
    const runs = { ...this.s.toolRuns };
    for (const [k, v] of Object.entries(runs)) if (['running', 'awaiting', 'pending'].includes(v.status)) runs[k] = { ...v, status: 'cancelled' };
    this.set({ toolRuns: runs, live: null, pending: null });
    this.notice('Interrupted by user', 'interrupt');
    this.push({ role: 'user', content: '[Request interrupted by user]', _meta: 'interrupt' });
  }

  onModelEvent(e) {
    const live = this.s.live; if (!live) return;
    if (e.type === 'text') this.set({ live: { ...live, text: live.text + e.text } });
    else if (e.type === 'thinking') this.set({ live: { ...live, thinking: live.thinking + e.text } });
    else if (e.type === 'tool_start') this.set({ live: { ...live, calls: [...live.calls.filter(c => c.id !== e.id), { id: e.id, name: e.name, partial: '' }] } });
    else if (e.type === 'tool_delta') this.set({ live: { ...live, calls: live.calls.map(c => c.id === e.id ? { ...c, partial: (c.partial + e.partial).slice(-4000) } : c) } });
    else if (e.type === 'status') this.set({ live: { ...live, status: e.text } });
    else if (e.type === 'search_results') this.set({ live: { ...live, status: `Found ${e.results.length} results` } });
  }

  addUsage(ref, u) {
    if (!u) return;
    const p = parseRef(ref);
    let cost = 0;
    const price = { 'claude-opus-5-5': [4, 20], 'claude-sonnet-5-5': [2, 10], 'claude-haiku-5-5': [0.1, 0.5], 'claude-fable-5-2': [8, 40] }[p?.model];
    if (price) cost = (u.input * price[0] + u.output * price[1]) / 1e6;
    this.set(s => ({ ...s, usage: { input: s.usage.input + (u.input || 0), output: s.usage.output + (u.output || 0), cost: (s.usage.cost || 0) + cost, tps: u.tps || s.usage.tps } }));
  }

  // Strips UI-only fields; clips old large tool results for small local context windows.
  messagesForModel() {
    const msgs = this.s.messages.filter(m => !m._hidden);
    const local = this.isLocal();
    const keepFull = 4;
    return msgs.map((m, i) => {
      if (typeof m.content === 'string') return { role: m.role, content: m.content };
      const old = local && i < msgs.length - keepFull;
      return { role: m.role, content: m.content.map(b => {
        if (b.type === 'tool_result') {
          const c = old && typeof b.content === 'string' && b.content.length > 1500 ? clip(b.content, 1500) : b.content;
          return { type: 'tool_result', tool_use_id: b.tool_use_id, content: c, ...(b.is_error ? { is_error: true } : {}) };
        }
        if (b.type === 'thinking' && !b.signature) return null;
        return b;
      }).filter(Boolean) };
    }).filter(m => typeof m.content === 'string' ? m.content : m.content.length);
  }

  // ---------- tools ----------
  async runTools(calls, tools, signal) {
    const byName = new Map(tools.map(t => [t.name, t]));
    const results = new Array(calls.length);
    const setRun = (id, patch) => this.set(s => ({ ...s, toolRuns: { ...s.toolRuns, [id]: { ...(s.toolRuns[id] || {}), ...patch } } }));
    for (const c of calls) setRun(c.id, { status: 'pending', name: c.name });
    const runOne = async (c, i) => {
      const tool = byName.get(c.name);
      const fail = (msg, extra = {}) => { setRun(c.id, { status: 'error', error: msg, ...extra }); results[i] = { type: 'tool_result', tool_use_id: c.id, content: msg, is_error: true, ...extra.res }; };
      if (!tool) return fail(`Unknown tool "${c.name}". Available: ${[...byName.keys()].join(', ')}`);
      if (c.input?._invalid_json != null) return fail(`The tool input was not valid JSON. Send valid JSON matching the schema.`);
      const input = coerceInput(tool.input_schema, c.input || {});
      const err = validateInput(tool.input_schema, input);
      if (err) return fail(`Invalid input: ${err}. Fix the arguments and call the tool again.`);
      const pre = await runHooks('PreToolUse', { tool: tool.name, input, cwd: this.cwd }, { cwd: this.cwd }).catch(() => ({ messages: [] }));
      if (pre.block) return fail(`Blocked by a PreToolUse hook: ${pre.block}`);
      const root = this.depth ? this.parent : this;
      const d = decide(tool, input, { mode: this.mode, sessionAllow: root.sessionAllow, cwd: this.cwd });
      if (d.decision === 'deny') return fail(d.reason || 'Not allowed.');
      if (d.decision === 'ask') {
        setRun(c.id, { status: 'awaiting' });
        let preview = null;
        try { preview = tool.preview ? await tool.preview(input, { cwd: this.cwd, session: this }) : null; } catch {}
        const answer = await root.requestPermission({ toolUseId: c.id, tool: tool.name, input, preview, summary: tool.summary?.(input), kind: tool.kind, rule: ruleFor(tool, input), from: this.depth ? 'subagent' : null });
        if (!answer || answer.choice === 'no') {
          setRun(c.id, { status: 'denied' });
          results[i] = { type: 'tool_result', tool_use_id: c.id, content: answer?.feedback ? `The user rejected this action and said: ${answer.feedback}` : 'The user rejected this action. Stop and wait for instructions.', is_error: true, _denied: true, _feedback: !!answer?.feedback };
          return;
        }
        if (answer.choice === 'always') { if (answer.persist) addRule('allow', ruleFor(tool, input)); else root.sessionAllow.push(ruleFor(tool, input)); }
        if (answer.choice === 'acceptEdits') root.setMode('acceptEdits');
      }
      setRun(c.id, { status: 'running', started: Date.now() });
      const t0 = performance.now();
      try {
        const out = await tool.run(input, this.toolCtx(c.id, signal));
        const norm = typeof out === 'string' || Array.isArray(out) ? { content: out } : (out || { content: '' });
        const post = await runHooks('PostToolUse', { tool: tool.name, input, output: typeof norm.content === 'string' ? norm.content.slice(0, 4000) : '', cwd: this.cwd }, { cwd: this.cwd }).catch(() => ({ messages: [] }));
        let content = norm.content ?? '';
        if (post.messages.length) content = (typeof content === 'string' ? content : toolResultText(content)) + '\n\n' + post.messages.map(m => `<hook>${m}</hook>`).join('\n');
        setRun(c.id, { status: norm.isError ? 'error' : 'done', ms: performance.now() - t0, display: norm.display || null, error: norm.isError ? (typeof content === 'string' ? content.slice(0, 500) : 'Error') : null, progress: null });
        results[i] = { type: 'tool_result', tool_use_id: c.id, content: content === '' ? '(empty)' : content, ...(norm.isError ? { is_error: true } : {}) };
      } catch (e) {
        if (signal.aborted) throw e;
        fail(String(e?.message || e), { ms: performance.now() - t0 });
      }
    };
    // Read-only tools run in parallel; anything else runs in order.
    const ro = calls.map((c, i) => [c, i]).filter(([c]) => byName.get(c.name)?.readOnly && !['AskUser', 'ExitPlanMode', 'Task'].includes(c.name));
    const rest = calls.map((c, i) => [c, i]).filter(([c]) => !ro.some(([x]) => x === c));
    await Promise.all(ro.map(([c, i]) => runOne(c, i)));
    for (const [c, i] of rest) { if (signal.aborted) break; await runOne(c, i); if (results[i]?._denied && !results[i]._feedback) { for (const [c2, j] of rest) if (!results[j]) { results[j] = { type: 'tool_result', tool_use_id: c2.id, content: 'Skipped because the user rejected an earlier action.', is_error: true }; setRun(c2.id, { status: 'cancelled' }); } break; } }
    if (signal.aborted) return 'interrupted';
    return results.map(r => r || { type: 'tool_result', tool_use_id: 'unknown', content: 'Skipped', is_error: true });
  }

  toolCtx(toolUseId, signal) {
    const session = this;
    const root = this.depth ? this.parent : this;
    return {
      session, cwd: this.cwd, signal,
      onProgress: (p) => this.set(s => ({ ...s, toolRuns: { ...s.toolRuns, [toolUseId]: { ...s.toolRuns[toolUseId], progress: p } } })),
      checkpoint: async (path, before) => { const cp = root.checkpoints[root.checkpoints.length - 1]; if (cp && !cp.files.has(path)) cp.files.set(path, before); },
      askUser: (questions) => root.request({ type: 'question', questions }),
      approvePlan: (plan) => root.request({ type: 'plan', plan }).then(v => { if (v && v !== 'reject') this.setMode(v); return v || 'reject'; }),
      runSubagent: (input) => this.runSubagent(input, toolUseId, signal),
    };
  }

  request(obj) {
    return new Promise((resolve) => {
      this.set({ pending: { ...obj, resolve: (v) => { this.set({ pending: null, status: this.abort ? 'running' : 'idle' }); resolve(v); } }, status: 'waiting' });
    });
  }
  requestPermission(req) { return this.request({ type: 'permission', ...req }); }

  async runSubagent({ prompt, subagent_type = 'general', description }, toolUseId, signal) {
    const agents = await loadMarkdownItems('agents', this.cwd);
    const def = agents.find(a => a.name === subagent_type);
    if (subagent_type !== 'general' && !def) throw new Error(`No subagent named "${subagent_type}". Available: general, ${agents.map(a => a.name).join(', ')}`);
    const child = new Session({
      kind: 'sub', depth: this.depth + 1, parent: this.depth ? this.parent : this, cwd: this.cwd, mode: this.mode === 'plan' ? 'plan' : this.mode,
      model: def?.data?.model && def.data.model !== 'inherit' ? def.data.model : (this.s.model || ''),
      allowedTools: Array.isArray(def?.data?.tools) ? def.data.tools : null,
      extraSystem: `# You are a subagent${def ? ` ("${def.name}")` : ''}\n${def?.body || 'Complete the task autonomously with the tools available, then reply with a concise final report. The report is all the caller sees.'}`,
    });
    let toolsUsed = 0;
    const off = child.store.subscribe((st) => {
      const runs = Object.values(st.toolRuns);
      toolsUsed = runs.length;
      const last = runs[runs.length - 1];
      this.set(s => ({ ...s, toolRuns: { ...s.toolRuns, [toolUseId]: { ...s.toolRuns[toolUseId], progress: last ? `${last.name}${last.status === 'running' ? '…' : ''} · ${runs.length} tool uses` : 'Starting…' } } }));
    });
    const onAbort = () => child.stop();
    signal.addEventListener('abort', onAbort);
    try {
      await child.send(prompt);
    } finally { off(); signal.removeEventListener('abort', onAbort); }
    const msgs = child.s.messages;
    const lastA = [...msgs].reverse().find(m => m.role === 'assistant');
    this.addUsage(child.modelRef(), child.s.usage);
    if (child.s.error) throw new Error('Subagent failed: ' + child.s.error);
    return { text: lastA ? textOf(lastA.content) : '', turns: msgs.length, tools: toolsUsed };
  }

  // ---------- context management ----------
  estimateTokens(system = '', tools = []) {
    let n = estimateTokens(system) + estimateTokens(JSON.stringify(tools.map(t => [t.name, t.description, t.input_schema])));
    for (const m of this.s.messages) n += estimateTokens(typeof m.content === 'string' ? m.content : JSON.stringify(m.content.map(b => b.type === 'image' ? { type: 'image' } : b))) + (blocks(m.content).filter(b => b.type === 'image').length * 1200);
    return n;
  }

  async maybeCompact(ref, system, tools) {
    const cfg = settings.get().agent || {};
    if (cfg.autoCompact === false || this.s.messages.length < 6) return;
    const limit = contextWindow(ref);
    const used = this.estimateTokens(system, tools);
    if (used < limit * (cfg.compactAt || 0.8)) return;
    this.notice(`Context is ${Math.round(used / limit * 100)}% full; compacting the conversation…`, 'info');
    await this.compact('', ref);
  }

  async compact(instructions = '', ref = this.modelRef()) {
    const msgs = this.s.messages;
    if (msgs.length < 3) return;
    // Keep the last exchange intact; summarize everything before it.
    let cut = msgs.length - 2;
    while (cut > 0 && !(msgs[cut].role === 'user' && typeof msgs[cut].content === 'string')) cut--;
    if (cut <= 1) cut = Math.max(1, msgs.length - 2);
    const older = msgs.slice(0, cut);
    const transcript = older.map(m => `${m.role.toUpperCase()}: ${blocks(m.content).map(b => b.type === 'text' ? b.text : b.type === 'tool_use' ? `[called ${b.name} ${JSON.stringify(b.input).slice(0, 300)}]` : b.type === 'tool_result' ? `[result: ${toolResultText(b.content).slice(0, this.isLocal() ? 300 : 1200)}]` : '').join('\n')}`).join('\n\n');
    const prompt = `Summarize this conversation so work can continue seamlessly. Include: the user's goals and requests, decisions made, files created/changed (paths), commands run and their important results, errors and how they were fixed, the current state, and what remains to do. Be specific and complete but concise.${instructions ? `\nExtra instructions: ${instructions}` : ''}\n\n<conversation>\n${clip(transcript, this.isLocal() ? 12000 : 400000)}\n</conversation>`;
    const r = await chat(ref, { system: 'You write precise summaries of agent sessions.', messages: [{ role: 'user', content: prompt }], maxTokens: this.isLocal() ? 1024 : 8000, thinking: 'off' });
    const summary = textOf(r.content).trim();
    if (!summary) throw new Error('Compaction failed: the model returned no summary.');
    this.set(s => ({ ...s, messages: [{ role: 'user', content: `This session is being continued from an earlier conversation that ran out of context. Summary of the earlier part:\n\n${summary}`, _meta: 'summary' }, { role: 'assistant', content: 'Understood. I have the context from the summary and will continue from there.', _meta: 'summary' }, ...msgs.slice(cut)], notices: [...s.notices, { at: 0, text: 'Conversation compacted', kind: 'info', t: Date.now() }] }));
    await this.save();
  }

  // Restores files changed since the last user message and removes that exchange.
  async rewind() {
    const cp = this.checkpoints.pop();
    if (!cp) return 0;
    let n = 0;
    for (const [path, before] of cp.files) {
      if (before == null) await vfs.rm(path).catch(() => {}); else await vfs.write(path, before);
      n++;
    }
    this.set(s => ({ ...s, messages: s.messages.slice(0, cp.at) }));
    await this.save();
    return n;
  }

  clear() {
    this.stop();
    this.readFiles.clear(); this.checkpoints = []; this.sessionAllow = []; this.queue = [];
    this.set({ messages: [], todos: [], toolRuns: {}, notices: [], error: null, usage: { input: 0, output: 0, cost: 0 }, title: 'New session' });
  }
}

function slimRuns(runs) {
  const out = {};
  for (const [k, v] of Object.entries(runs)) {
    const d = v.display;
    out[k] = { ...v, progress: null, display: d?.kind === 'diff' && (d.before?.length + d.after?.length > 200000) ? { ...d, before: '', after: '', truncated: true } : d };
  }
  return out;
}

function titleFrom(text) {
  const t = text.replace(/\s+/g, ' ').trim().replace(/^[/!#@]\S*\s*/, '');
  return (t.length > 48 ? t.slice(0, 46).replace(/\s\S*$/, '') + '…' : t) || 'New session';
}

async function expandMentions(text, cwd) {
  const files = [];
  const re = /(^|\s)@([^\s]+)/g; let m;
  while ((m = re.exec(text))) {
    const p = vfs.normalize(m[2], cwd);
    try { const st = await vfs.stat(p); if (st.kind === 'file' && st.size < 200000) files.push({ path: p, text: await vfs.readText(p) }); else if (st.kind === 'directory') files.push({ path: p, text: (await vfs.list(p)).map(e => e.name + (e.kind === 'directory' ? '/' : '')).join('\n') }); } catch {}
  }
  return { files };
}

// ---------- index of saved sessions ----------
export async function loadIndex() {
  const list = [];
  for (const e of await vfs.list('/chats').catch(() => [])) {
    if (!e.name.endsWith('.json')) continue;
    try {
      const f = await vfs.getFile(e.path);
      // Read only the head for speed.
      const head = await f.slice(0, 2000).text();
      const g = (k) => { const mm = new RegExp(`"${k}":\\s*"([^"]*)"`).exec(head); return mm ? mm[1] : ''; };
      const num = (k) => { const mm = new RegExp(`"${k}":\\s*(\\d+)`).exec(head); return mm ? Number(mm[1]) : 0; };
      list.push({ id: g('id') || e.name.replace(/\.json$/, ''), kind: g('kind') || 'agent', title: g('title') || 'Untitled', updated: num('updated') || e.mtime, cwd: g('cwd'), model: g('model') });
    } catch {}
  }
  list.sort((a, b) => b.updated - a.updated);
  sessionsIndex.set({ list });
  return list;
}
function upsertIndex(item) {
  sessionsIndex.set(s => ({ list: [item, ...s.list.filter(x => x.id !== item.id)] }));
}
export async function deleteSession(id) {
  await vfs.rm(`/chats/${id}.json`).catch(() => {});
  sessionsIndex.set(s => ({ list: s.list.filter(x => x.id !== id) }));
}

export { modelLabel, parseFrontMatter };
