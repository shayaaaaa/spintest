// Claude Code–style transcript: user prompts, ⏺ assistant text, ⏺ Tool(args) with ⎿ results, diffs, todos, live
// streaming, spinner, inline permission prompts.
import { html, useState, useEffect, useRef, useMemo } from '../../../vendor/preact.mjs';
import { useStore } from '../../core/store.js';
import { Icon } from '../icons.js';
import { Markdown, DiffView } from '../kit.js';
import { blocks, toolResultText } from '../../models/content.js';
import { fmtNum, truncate, extractJSON } from '../../core/util.js';
import { PromptView } from './prompts.js';
import { openFileInEditor } from '../layout.js';
import * as vfs from '../../core/vfs.js';

const SUMMARY_KEYS = { Read: 'file_path', Write: 'file_path', Edit: 'file_path', MultiEdit: 'file_path', Glob: 'pattern', Grep: 'pattern', LS: 'path', Bash: 'command', WebFetch: 'url', WebSearch: 'query', Skill: 'skill', Task: 'description', Python: 'code', RunJS: 'code', Document: 'path', ViewImage: 'path', Memory: 'title', Recall: 'query', RunShortcut: 'name', OpenURL: 'url', Preview: 'path', Media: 'outputs', ImageEdit: 'input', Models: 'action', Dataset: 'name', Train: 'action', Browser: 'url' };
export function toolSummary(name, input) {
  if (!input || typeof input !== 'object') return '';
  if (name === 'TodoWrite') return `${input.todos?.length || 0} items`;
  if (name === 'AskUser') return truncate(input.questions?.[0]?.question || '', 80);
  if (name === 'ExitPlanMode') return 'plan';
  const k = SUMMARY_KEYS[name];
  let v = k ? input[k] : Object.values(input).find(x => typeof x === 'string');
  if (Array.isArray(v)) v = v.join(', ');
  if (name === 'Grep' && input.path) v = `"${v}" in ${input.path}`;
  if (name === 'Glob' && input.path) v = `${v} in ${input.path}`;
  if (name === 'Document') v = `${input.action} ${input.path}`;
  if (name === 'Memory') v = `${input.action}${input.title ? ': ' + input.title : ''}`;
  if (name === 'Task') v = `${input.subagent_type || 'general'}: ${input.description}`;
  return truncate(String(v ?? '').split('\n')[0], 120);
}

const displayName = (n) => n.startsWith('mcp__') ? n.split('__').slice(1).join(' · ') : n === 'TodoWrite' ? 'Update Todos' : n;

function Elapsed({ since }) {
  const [, t] = useState(0);
  useEffect(() => { const i = setInterval(() => t(x => x + 1), 1000); return () => clearInterval(i); }, []);
  const s = Math.floor((Date.now() - since) / 1000);
  return html`${s < 60 ? s + 's' : Math.floor(s / 60) + 'm ' + (s % 60) + 's'}`;
}

function TodoList({ todos }) {
  return html`<ul class="todos">${todos.map(t => html`<li class=${t.status === 'completed' ? 'done' : t.status === 'in_progress' ? 'doing' : ''}><span class="box">${t.status === 'completed' ? '☒' : '☐'}</span><span>${t.status === 'in_progress' ? (t.activeForm || t.content) : t.content}</span></li>`)}</ul>`;
}

function Collapsible({ text, lines = 6, cls = 't-out' }) {
  const [open, setOpen] = useState(false);
  const n = text.split('\n').length;
  const long = n > lines || text.length > 600;
  return html`<div><div class=${cls + (long && !open ? ' collapsed' : '')}>${text}</div>${long && html`<button class="t-more" onClick=${() => setOpen(!open)}>${open ? 'Show less' : `Show all ${n} lines`}</button>`}</div>`;
}

function HubImage({ path }) {
  const [url, setUrl] = useState(null);
  useEffect(() => { let u; vfs.getFile(path).then(f => { u = URL.createObjectURL(f); setUrl(u); }).catch(() => {}); return () => u && URL.revokeObjectURL(u); }, [path]);
  return url ? html`<img src=${url} alt=${path} onClick=${() => openFileInEditor(path)} />` : null;
}

function ResultLine({ run, input, name, resultText }) {
  const d = run?.display;
  const st = run?.status;
  if (!run || st === 'pending') return html`<div class="t-result"><span class="grow">Pending…</span></div>`;
  if (st === 'awaiting') return html`<div class="t-result"><span class="grow warn">Waiting for your permission…</span></div>`;
  if (st === 'running') return html`<div class="t-result"><span class="grow">${run.progress ? html`<${Collapsible} text=${String(run.progress)} lines=${4} />` : 'Running…'}</span></div>`;
  if (st === 'denied') return html`<div class="t-result err"><span class="grow">Rejected by you</span></div>`;
  if (st === 'cancelled') return html`<div class="t-result err"><span class="grow">Interrupted</span></div>`;
  if (st === 'error') return html`<div class="t-result err"><span class="grow">${truncate(run.error || resultText || 'Error', 600)}</span></div>`;
  if (!d) return html`<div class="t-result"><span class="grow">${truncate(resultText || 'Done', 300)}</span></div>`;
  switch (d.kind) {
    case 'read': return html`<div class="t-result"><span class="grow">${d.image ? 'Read image' : `Read ${d.lines} line${d.lines === 1 ? '' : 's'}${d.total && d.total > d.lines ? ` of ${d.total}` : ''}`}</span></div>`;
    case 'diff': return html`<div class="t-result"><span class="grow">${d.created ? 'Created' : 'Updated'} <a onClick=${(e) => { e.preventDefault(); openFileInEditor(d.path); }} href="#">${d.path}</a> with <span class="add">${d.add} addition${d.add === 1 ? '' : 's'}</span> and <span class="del">${d.del} removal${d.del === 1 ? '' : 's'}</span>
      ${!d.truncated && html`<div class="t-diff"><${DiffView} before=${d.before} after=${d.after} maxLines=${120} /></div>`}</span></div>`;
    case 'count': return html`<div class="t-result"><span class="grow">${d.n === 0 ? `No ${d.noun || 'result'}s found` : `Found ${d.n} ${d.noun || 'result'}${d.n === 1 ? '' : 's'}`}</span></div>`;
    case 'shell': return html`<div class="t-result"><span class="grow">${d.output ? html`<${Collapsible} text=${d.output.trimEnd()} />` : '(no output)'}${d.code ? html`<div class="err">exit code ${d.code}</div>` : ''}${d.images?.length ? html`<div class="t-images">${d.images.map(p => html`<${HubImage} path=${p} />`)}</div>` : ''}</span></div>`;
    case 'todos': return html`<div class="t-result"><span class="grow"><${TodoList} todos=${d.todos} /></span></div>`;
    case 'search': return html`<div class="t-result"><span class="grow">${d.results.length} results<div class="t-links">${d.results.slice(0, 6).map(r => html`<a href=${r.url} target="_blank" rel="noopener">${r.title || r.url}</a>`)}</div></span></div>`;
    case 'web': return html`<div class="t-result"><span class="grow">Fetched ${fmtNum(d.chars)} characters</span></div>`;
    case 'answers': return html`<div class="t-result"><span class="grow">${Object.entries(d.answers).map(([q, a]) => html`<div>· ${q} → <b>${Array.isArray(a) ? a.join(', ') : a}</b></div>`)}</span></div>`;
    case 'plan': return html`<div class="t-result"><span class="grow">Plan approved (${d.decision})</span></div>`;
    case 'subagent': return html`<div class="t-result"><span class="grow">Done (${d.tools} tool use${d.tools === 1 ? '' : 's'})</span></div>`;
    case 'image': return html`<div class="t-result"><span class="grow"><div class="t-images"><${HubImage} path=${d.path} /></div></span></div>`;
    case 'file': return html`<div class="t-result"><span class="grow">Saved <a href="#" onClick=${(e) => { e.preventDefault(); openFileInEditor(d.path); }}>${d.path}</a></span></div>`;
    default: return html`<div class="t-result"><span class="grow">${d.text || truncate(resultText || 'Done', 300)}</span></div>`;
  }
}

function ToolCall({ block, run, resultText }) {
  const st = run?.status;
  const dot = st === 'done' ? 'ok' : st === 'error' ? 'err' : st === 'denied' || st === 'cancelled' ? 'deny' : st === 'awaiting' ? 'wait' : 'run';
  const args = toolSummary(block.name, block.input);
  return html`<div class="t-item">
    <div class="t-row"><span class=${'t-dot ' + dot}>⏺</span><div class="t-body"><span class="t-tool-name">${displayName(block.name)}</span>${args && html`<span class="t-tool-args">(${args})</span>`}
      <${ResultLine} run=${run} input=${block.input} name=${block.name} resultText=${resultText} /></div></div>
  </div>`;
}

function UserMessage({ m }) {
  if (m._meta === 'interrupt') return null;
  if (m._meta === 'summary') return html`<div class="t-item"><details class="t-thinking"><summary>✻ Earlier conversation (summarized) — tap to view</summary><div style="margin-top:6px">${typeof m.content === 'string' ? m.content : ''}</div></details></div>`;
  const bl = blocks(m.content);
  if (bl.some(b => b.type === 'tool_result') && !bl.some(b => b.type === 'text')) return null;
  const texts = bl.filter(b => b.type === 'text' && !b.text.startsWith('<file path=') && !b.text.startsWith('<hook-context>')).map(b => b.text).join('\n');
  const files = bl.filter(b => b.type === 'text' && b.text.startsWith('<file path=')).map(b => /<file path="([^"]+)"/.exec(b.text)?.[1]);
  const imgs = bl.filter(b => b.type === 'image');
  const docs = bl.filter(b => b.type === 'document');
  if (!texts && !files.length && !imgs.length) return null;
  const bash = /^<bash-input>([\s\S]*?)<\/bash-input>/.exec(texts);
  if (bash) {
    const out = /<bash-stdout>([\s\S]*?)<\/bash-stdout>/.exec(texts)?.[1] || '';
    return html`<div class="t-item"><div class="t-user bash" style="border-color:#d08cff55"><span style="color:#d08cff">!</span> ${bash[1]}</div>${out && html`<div class="t-result" style="margin-top:4px"><span class="grow"><${Collapsible} text=${out.trimEnd()} /></span></div>`}</div>`;
  }
  return html`<div class="t-item"><div class="t-user">${texts}${files.map(f => html`<span class="att"><${Icon} name="file" size=${12} />${f}</span>`)}${docs.map(d => html`<span class="att"><${Icon} name="fileText" size=${12} />${d.title || 'document'}</span>`)}${imgs.length ? html`<div>${imgs.map(b => html`<img src=${`data:${b.source.media_type};base64,${b.source.data}`} alt="attachment" />`)}</div>` : ''}</div></div>`;
}

function AssistantBlocks({ m, runs, results, showThinking }) {
  return html`${blocks(m.content).map((b, i) => {
    if (b.type === 'text') return html`<div class="t-item" key=${i}><div class="t-row"><span class="t-dot text">⏺</span><div class="t-body"><${Markdown} text=${b.text} /></div></div></div>`;
    if (b.type === 'thinking' && (b.thinking || '').trim() && showThinking) return html`<div class="t-item" key=${i}><details class="t-thinking"><summary>✻ Thought for a moment — tap to read</summary><div style="margin-top:4px">${b.thinking}</div></details></div>`;
    if (b.type === 'tool_use') return html`<${ToolCall} key=${b.id} block=${b} run=${runs[b.id]} resultText=${results.get(b.id)} />`;
    if (b.type === 'server_tool_use') return html`<div class="t-item" key=${i}><div class="t-row"><span class="t-dot ok">⏺</span><div class="t-body"><span class="t-tool-name">Web search</span><span class="t-tool-args">(${b.input?.query || ''})</span></div></div></div>`;
    if (b.type === 'web_search_tool_result' && Array.isArray(b.content)) return html`<div class="t-item" key=${i} style="margin-top:-10px"><div class="t-result"><span class="grow">${b.content.length} results<div class="t-links">${b.content.slice(0, 5).map(r => html`<a href=${r.url} target="_blank" rel="noopener">${r.title || r.url}</a>`)}</div></span></div></div>`;
    return null;
  })}`;
}

function LiveBlock({ live, todos, session }) {
  const partialCalls = live.calls || [];
  const tokens = Math.round((live.text.length + live.thinking.length + partialCalls.reduce((a, c) => a + c.partial.length, 0)) / 3.6);
  return html`
    ${live.thinking && html`<div class="t-item"><details class="t-thinking" open=${!live.text}><summary>✻ Thinking…</summary><div style="margin-top:4px;max-height:160px;overflow:auto">${live.thinking.slice(-3000)}</div></details></div>`}
    ${live.text && html`<div class="t-item"><div class="t-row"><span class="t-dot text">⏺</span><div class="t-body"><${Markdown} text=${live.text} /></div></div></div>`}
    ${partialCalls.map(c => { const inp = extractJSON(c.partial); return html`<div class="t-item"><div class="t-row"><span class="t-dot run">⏺</span><div class="t-body"><span class="t-tool-name">${displayName(c.name)}</span><span class="t-tool-args">(${inp ? toolSummary(c.name, inp) : '…'})</span><div class="t-result"><span class="grow">Writing… ${fmtNum(c.partial.length)} chars</span></div></div></div></div>`; })}
    <div class="spin-line"><span class="spin-glyph">✻</span><span>${live.status || live.word + '…'}</span><span class="dim">(<${Elapsed} since=${live.started} />${tokens ? ` · ↓ ${fmtNum(tokens)} tokens` : ''} · tap ■ to stop)</span></div>
    ${todos.length > 0 && html`<div class="t-item" style="margin-left:22px"><${TodoList} todos=${todos} /></div>`}`;
}

export function Transcript({ session, welcome, monoMarkdown = false, showThinking = true, onRetry }) {
  const st = useStore(session.store);
  const ref = useRef();
  const stick = useRef(true);
  const [showJump, setShowJump] = useState(false);
  const results = useMemo(() => {
    const m = new Map();
    for (const msg of st.messages) if (msg.role === 'user') for (const b of blocks(msg.content)) if (b.type === 'tool_result') m.set(b.tool_use_id, toolResultText(b.content));
    return m;
  }, [st.messages]);
  useEffect(() => { const el = ref.current; if (el && stick.current) el.scrollTop = el.scrollHeight; });
  useEffect(() => { stick.current = true; const el = ref.current; if (el) el.scrollTop = el.scrollHeight; }, [session]);
  const onScroll = () => { const el = ref.current; const near = el.scrollHeight - el.scrollTop - el.clientHeight < 80; stick.current = near; if (showJump === near) setShowJump(!near); };
  const notesAt = (i) => st.notices.filter(n => n.at === i).map(n => html`<div class=${'t-notice ' + n.kind}>⎿ ${n.text}</div>`);
  return html`<div style="flex:1;min-height:0;display:flex;flex-direction:column;position:relative">
    <div class=${'term' + (monoMarkdown ? ' mono-md' : '')} ref=${ref} onScroll=${onScroll}>
      ${!st.messages.length && welcome}
      ${st.messages.map((m, i) => html`${notesAt(i)}${m.role === 'user' ? html`<${UserMessage} m=${m} />` : html`<${AssistantBlocks} m=${m} runs=${st.toolRuns} results=${results} showThinking=${showThinking} />`}`)}
      ${notesAt(st.messages.length)}
      ${st.live && html`<${LiveBlock} live=${st.live} todos=${st.todos} session=${session} />`}
      ${!st.live && st.status === 'running' && html`<div class="spin-line"><span class="spin-glyph">✻</span><span>Working…</span></div>`}
      ${st.pending && html`<${PromptView} session=${session} pending=${st.pending} />`}
      ${st.error && html`<div class="err-box"><${Icon} name="alert" /><div class="grow">${st.error}${onRetry && html`<div style="margin-top:8px"><button class="btn sm" onClick=${onRetry}><${Icon} name="refresh" />Try again</button></div>`}</div></div>`}
      ${!st.live && st.status === 'idle' && st.todos.length > 0 && st.todos.some(t => t.status !== 'completed') && html`<div class="t-item" style="margin-left:22px"><${TodoList} todos=${st.todos} /></div>`}
    </div>
    ${showJump && html`<button class="ibtn round solid jump" style="position:absolute;bottom:12px;right:14px" onClick=${() => { stick.current = true; ref.current.scrollTop = ref.current.scrollHeight; setShowJump(false); }} aria-label="Scroll to bottom"><${Icon} name="arrowDown" /></button>`}
  </div>`;
}
