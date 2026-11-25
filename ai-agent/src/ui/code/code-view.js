// Code tab: a Cursor-style IDE — explorer, CodeMirror editor with tabs, AI panel (agent with review of its edits),
// Cmd-K inline edits, ghost-text completion, terminal and live preview.
import { html, useState, useEffect, useRef, useLayoutEffect } from '../../../vendor/preact.mjs';
import { createStore, useStore } from '../../core/store.js';
import { Icon, fileIcon } from '../icons.js';
import { openMenu, toast, promptDialog, Empty } from '../kit.js';
import * as vfs from '../../core/vfs.js';
import { settings } from '../../core/settings.js';
import { bus } from '../../core/bus.js';
import { isTextName, extOf, debounce } from '../../core/util.js';
import { createEditor, setReview, ghostCompletion, replaceDoc } from './editor.js';
import { FileTree, newEntry } from './explorer.js';
import { Terminal } from './terminal.js';
import { Preview } from './preview.js';
import { current, getSession, newSession } from '../../agent/manager.js';
import { Transcript } from '../session/transcript.js';
import { Composer } from '../session/composer.js';
import { handleSubmit } from '../session/submit.js';
import { makeUi } from '../agent/agent-view.js';
import { MODES, nextMode } from '../../agent/permissions.js';
import { openProjectPicker, ModelStatus } from '../pickers.js';
import { modelFor, chat, modelLabel, parseRef, getEngine } from '../../models/registry.js';
import { textOf } from '../../models/content.js';
import { showTab } from '../layout.js';

export const codeStore = createStore({
  root: settings.get().lastProject?.startsWith('/workspace/') ? settings.get().lastProject : '/workspace/welcome',
  open: [], active: null, explorer: false, ai: false, bottom: null, previewPath: null, reviews: {}, dirty: {},
});
const states = new Map(); // path -> EditorState (keeps undo history per file)

export function openFile(path, line) {
  const st = codeStore.get();
  if (!st.open.includes(path)) codeStore.set({ open: [...st.open, path] });
  codeStore.set({ active: path, _line: line || null });
  if (path.startsWith('/workspace/')) { const root = path.split('/').slice(0, 3).join('/'); if (!st.root.startsWith(root) && !path.startsWith(st.root)) codeStore.set({ root }); }
}
bus.on('open-file', ({ path, line }) => { if (isTextName(path)) { openFile(path, line); showTab('code'); } else if (/\.html?$/.test(path)) { codeStore.set({ previewPath: path, bottom: 'preview' }); showTab('code'); } else { import('../hub/hub-view.js').then(m => m.previewFile?.(path)); } });
bus.on('preview', ({ path }) => { codeStore.set({ previewPath: path, bottom: 'preview' }); showTab('code'); });

function useWidth(ref) {
  const [w, setW] = useState(400);
  useLayoutEffect(() => { const ro = new ResizeObserver(([e]) => setW(e.contentRect.width)); if (ref.current) ro.observe(ref.current); return () => ro.disconnect(); }, []);
  return w;
}

export function CodeView({ pane, active }) {
  const st = useStore(codeStore);
  const host = useRef(); const wrap = useRef(); const view = useRef(null);
  const width = useWidth(wrap);
  const wide = width >= 820, medium = width >= 560;
  const [inline, setInline] = useState(null); // {from, to, text}
  const [selBox, setSelBox] = useState(null);
  const loadingRef = useRef(false);
  const savedText = useRef(new Map());

  const save = async (path = codeStore.get().active, text) => {
    if (!path || !view.current) return;
    const doc = text ?? (path === codeStore.get().active ? view.current.state.doc.toString() : states.get(path)?.doc.toString());
    if (doc == null) return;
    savedText.current.set(path, doc);
    await vfs.write(path, doc);
    codeStore.set(s => ({ ...s, dirty: { ...s.dirty, [path]: false } }));
  };
  const autosave = useRef(debounce((p, t) => save(p, t), 700)).current;

  // Create the editor once.
  useEffect(() => {
    const complete = async (prefix, suffix, signal) => {
      const ref = modelFor('complete');
      if (!ref || !settings.get().code?.autocomplete) return '';
      return fetchCompletion(ref, prefix, suffix, signal, codeStore.get().active);
    };
    view.current = createEditor(host.current, {
      doc: '', path: '',
      onChange: (doc) => { if (loadingRef.current) return; const p = codeStore.get().active; if (!p) return; codeStore.set(s => ({ ...s, dirty: { ...s.dirty, [p]: true } })); autosave(p, doc); },
      onSave: () => save(),
      onSelection: (sel, v) => {
        if (sel.empty) return setSelBox(null);
        const c = v.coordsAtPos(sel.head); const r = host.current.getBoundingClientRect();
        if (c) setSelBox({ top: Math.max(4, c.top - r.top - 44), left: Math.min(r.width - 150, Math.max(4, c.left - r.left - 40)) });
      },
      onCmdK: () => startInline(),
      extra: [ghostCompletion(complete, () => !!settings.get().code?.autocomplete)],
      fontSize: settings.get().fontSize - 1.5,
    });
    return () => view.current?.destroy();
  }, []);

  // Switch documents when the active file changes (each file keeps its own state and undo history).
  useEffect(() => {
    const v = view.current; if (!v) return;
    const path = st.active;
    if (!path) return;
    let alive = true;
    (async () => {
      let state = states.get(path);
      if (!state) {
        let text = '';
        try { text = await vfs.readText(path); } catch { text = ''; }
        if (!alive) return;
        savedText.current.set(path, text);
        state = v._stateFor(text, path);
      }
      v.setState(state);
      const rev = codeStore.get().reviews[path];
      if (rev != null) setReview(v, rev);
      if (st._line) { const line = v.state.doc.line(Math.min(st._line, v.state.doc.lines)); v.dispatch({ selection: { anchor: line.from }, scrollIntoView: true }); }
    })();
    return () => { alive = false; if (v && v.state.doc && codeStore.get().active !== path) states.set(path, v.state); };
  }, [st.active]);

  // Remember the state of the outgoing file.
  useEffect(() => () => { if (view.current && st.active) states.set(st.active, view.current.state); }, [st.active]);

  // External changes (the agent, the terminal, Python…) → reload + offer review.
  useEffect(() => vfs.events.on('change', async (e) => {
    const s = codeStore.get();
    if (!s.open.includes(e.path)) return;
    if (e.type === 'rm') { closeTab(e.path, true); return; }
    let disk; try { disk = await vfs.readText(e.path); } catch { return; }
    const v = view.current;
    const cur = e.path === s.active && v ? v.state.doc.toString() : states.get(e.path)?.doc.toString();
    if (cur == null || disk === cur) return;
    if (s.dirty[e.path]) { toast(`${e.path.split('/').pop()} changed on disk while you were editing`, 'warn'); return; }
    const before = savedText.current.get(e.path) ?? cur;
    savedText.current.set(e.path, disk);
    codeStore.set(x => ({ ...x, reviews: { ...x.reviews, [e.path]: before } }));
    if (e.path === s.active && v) { replaceDoc(v, disk); setReview(v, before); }
    else states.delete(e.path);
  }), []);

  const closeTab = (path, silent) => {
    const s = codeStore.get();
    if (s.dirty[path] && !silent) save(path);
    states.delete(path);
    const open = s.open.filter(p => p !== path);
    const reviews = { ...s.reviews }; delete reviews[path];
    codeStore.set({ open, active: s.active === path ? open[open.length - 1] || null : s.active, reviews });
  };

  const acceptReview = () => { const p = st.active; setReview(view.current, null); codeStore.set(s => { const r = { ...s.reviews }; delete r[p]; return { ...s, reviews: r }; }); };
  const rejectReview = async () => {
    const p = st.active; const before = st.reviews[p];
    setReview(view.current, null);
    replaceDoc(view.current, before);
    codeStore.set(s => { const r = { ...s.reviews }; delete r[p]; return { ...s, reviews: r }; });
    await save(p, before);
    toast('Changes reverted', 'ok');
  };

  const startInline = () => {
    const v = view.current; if (!v || !st.active) return;
    const sel = v.state.selection.main;
    const line = v.state.doc.lineAt(sel.head);
    const from = sel.empty ? line.from : sel.from, to = sel.empty ? line.to : sel.to;
    setInline({ from, to, text: v.state.sliceDoc(from, to), q: '', busy: false });
    setSelBox(null);
  };
  const runInline = async () => {
    const v = view.current; const it = inline; if (!it.q.trim()) return;
    setInline({ ...it, busy: true });
    const before = v.state.doc.toString();
    try {
      const ref = modelFor('code');
      const lang = extOf(st.active);
      const ctxBefore = before.slice(Math.max(0, it.from - 2500), it.from), ctxAfter = before.slice(it.to, it.to + 1500);
      const r = await chat(ref, { system: 'You rewrite code exactly as instructed. Reply with ONLY the replacement code for the selection, in one fenced code block. No explanations.', messages: [{ role: 'user', content: `File: ${st.active}\n\nCode before the selection:\n\`\`\`${lang}\n${ctxBefore}\n\`\`\`\n\nSELECTION to rewrite:\n\`\`\`${lang}\n${it.text}\n\`\`\`\n\nCode after the selection:\n\`\`\`${lang}\n${ctxAfter}\n\`\`\`\n\nInstruction: ${it.q}` }], maxTokens: 3000, thinking: 'off' });
      let out = textOf(r.content);
      const m = /```[\w-]*\n?([\s\S]*?)```/.exec(out); if (m) out = m[1].replace(/\n$/, '');
      v.dispatch({ changes: { from: it.from, to: it.to, insert: out } });
      codeStore.set(s => ({ ...s, reviews: { ...s.reviews, [st.active]: before } }));
      setReview(v, before);
      setInline(null);
    } catch (e) { toast(String(e.message || e), 'err'); setInline({ ...it, busy: false }); }
  };

  const run = async () => {
    const p = st.active; if (!p) return;
    await save(p);
    const e = extOf(p);
    if (e === 'html' || e === 'htm') return codeStore.set({ previewPath: p, bottom: 'preview' });
    const cmd = e === 'py' ? `python ${p}` : ['js', 'mjs'].includes(e) ? `node ${p}` : e === 'sh' ? `sh ${p}` : null;
    if (!cmd) return toast('Run works for .html (preview), .py, .js and .sh files');
    codeStore.set({ bottom: 'terminal', _runCmd: cmd + '#' + Date.now() });
  };

  const showExplorer = st.explorer;
  const showAI = st.ai;
  const tab = (p) => html`<button class=${'ctab' + (p === st.active ? ' on' : '')} onClick=${() => codeStore.set({ active: p })}>
    <${Icon} name=${fileIcon(p)} size=${14} /><span class="ellipsis">${p.split('/').pop()}</span>${st.reviews[p] != null ? html`<span class="tag warn" style="padding:0 4px">review</span>` : ''}
    ${st.dirty[p] ? html`<span class="dirty"></span>` : html`<span class="x" onClick=${(e) => { e.stopPropagation(); closeTab(p); }} role="button" aria-label="Close"><${Icon} name="x" /></span>`}</button>`;

  return html`<div class="code" ref=${wrap}>
    <div class="phead code-head">
      <button class=${'ibtn sm' + (showExplorer ? ' active' : '')} onClick=${() => codeStore.set({ explorer: !showExplorer })} aria-label="Explorer"><${Icon} name="folder" /></button>
      <div class="code-tabs">${st.open.map(tab)}</div>
      <button class="ibtn sm" onClick=${run} disabled=${!st.active} aria-label="Run"><${Icon} name="play" /></button>
      <button class=${'ibtn sm' + (st.bottom === 'terminal' ? ' active' : '')} onClick=${() => codeStore.set({ bottom: st.bottom === 'terminal' ? null : 'terminal' })} aria-label="Terminal"><${Icon} name="terminal" /></button>
      <button class=${'ibtn sm' + (showAI ? ' active' : '')} onClick=${() => codeStore.set({ ai: !showAI })} aria-label="AI assistant"><${Icon} name="sparkles" /></button>
      <button class="ibtn sm" onClick=${(e) => openMenu(e.currentTarget, [
        { icon: 'file', text: 'New file…', onClick: () => newEntry(st.root, 'file', openFile) },
        { icon: 'folderOpen', text: 'Open project…', onClick: () => openProjectPicker({ current: st.root, onPick: (p) => codeStore.set({ root: p, explorer: true }) }) },
        { icon: 'save', text: 'Save', onClick: () => save() },
        { icon: 'globe', text: 'Preview index.html', onClick: () => codeStore.set({ previewPath: vfs.join(st.root, 'index.html'), bottom: 'preview' }) },
        '-',
        { icon: 'sparkles', text: settings.get().code?.autocomplete ? 'Turn off AI autocomplete' : 'Turn on AI autocomplete', sub: modelLabel(modelFor('complete')), onClick: () => settings.set(s => ({ ...s, code: { ...(s.code || {}), autocomplete: !s.code?.autocomplete } })) },
      ], { align: 'right' })} aria-label="More"><${Icon} name="moreV" /></button>
    </div>
    <div class="code-body">
      ${showExplorer && html`${!medium && html`<div class="scrim" style="position:absolute;z-index:29" onClick=${() => codeStore.set({ explorer: false })}></div>`}
        <div class=${'explorer' + (medium ? '' : ' overlay')}>
          <div class="explorer-head"><span class="grow ellipsis">${st.root.split('/').pop() || 'Hub'}</span>
            <button class="ibtn sm" onClick=${() => newEntry(st.root, 'file', (p) => { openFile(p); if (!medium) codeStore.set({ explorer: false }); })} aria-label="New file"><${Icon} name="plus" /></button>
            <button class="ibtn sm" onClick=${() => openProjectPicker({ current: st.root, onPick: (p) => codeStore.set({ root: p }) })} aria-label="Switch project"><${Icon} name="swap" /></button></div>
          <${FileTree} root=${st.root} selected=${st.active} onOpen=${(p) => { openFile(p); if (!medium) codeStore.set({ explorer: false }); }} />
        </div>`}
      <div class="code-main">
        ${st.active && st.reviews[st.active] != null && html`<div class="review-bar"><${Icon} name="sparkles" size=${16} /><span class="grow">Review changes to ${st.active.split('/').pop()}</span>
          <button class="btn sm" onClick=${rejectReview}>Reject all</button><button class="btn sm primary" onClick=${acceptReview}>Accept</button></div>`}
        ${inline && html`<div class="inline-edit"><${Icon} name="sparkles" size=${16} /><input class="input" autofocus placeholder=${inline.text.trim() ? 'Edit selection: e.g. "add error handling"' : 'Generate code here: describe it'} value=${inline.q} onInput=${e => setInline({ ...inline, q: e.target.value })} onKeyDown=${e => { if (e.key === 'Enter') runInline(); if (e.key === 'Escape') setInline(null); }} />
          ${inline.busy ? html`<div class="spinner"></div>` : html`<button class="btn sm primary" onClick=${runInline}>Go</button>`}<button class="ibtn sm" onClick=${() => setInline(null)} aria-label="Cancel"><${Icon} name="x" /></button></div>`}
        <div class="editor-host" ref=${host}>
          ${!st.active && html`<div class="editor-empty"><div><${Icon} name="code" size=${36} /><h3 style="margin:10px 0 4px">No file open</h3><div class="small">Open the explorer to pick a file, or ask the AI to build something.</div>
            <div class="kbd-row"><button class="btn" onClick=${() => codeStore.set({ explorer: true })}><${Icon} name="folder" />Open explorer</button><button class="btn" onClick=${() => codeStore.set({ ai: true })}><${Icon} name="sparkles" />Ask AI</button></div></div></div>`}
          ${selBox && st.active && !inline && html`<div class="sel-actions" style=${`top:${selBox.top}px;left:${selBox.left}px`}>
            <button class="btn sm" onPointerDown=${(e) => { e.preventDefault(); startInline(); }}><${Icon} name="sparkles" />Edit</button>
            <button class="btn sm" onPointerDown=${(e) => { e.preventDefault(); const v = view.current; const t = v.state.sliceDoc(v.state.selection.main.from, v.state.selection.main.to); codeStore.set({ ai: true, _ctx: { path: st.active, text: t } }); setSelBox(null); }}><${Icon} name="chat" />Ask</button></div>`}
        </div>
        ${st.bottom && html`<div class=${'bottom-panel' + (st._bpMax ? ' max' : '')}>
          <div class="bp-head"><div class="seg"><button class=${st.bottom === 'terminal' ? 'on' : ''} onClick=${() => codeStore.set({ bottom: 'terminal' })}><${Icon} name="terminal" />Terminal</button><button class=${st.bottom === 'preview' ? 'on' : ''} onClick=${() => codeStore.set({ bottom: 'preview', previewPath: st.previewPath || vfs.join(st.root, 'index.html') })}><${Icon} name="globe" />Preview</button></div>
            <span class="spacer"></span><button class="ibtn sm" onClick=${() => codeStore.set({ _bpMax: !st._bpMax })} aria-label="Maximize"><${Icon} name="maximize" /></button><button class="ibtn sm" onClick=${() => codeStore.set({ bottom: null })} aria-label="Close panel"><${Icon} name="x" /></button></div>
          ${st.bottom === 'terminal' ? html`<${TerminalRunner} root=${st.root} runCmd=${st._runCmd} />` : html`<${Preview} path=${st.previewPath} onNavigate=${(p) => codeStore.set({ previewPath: p })} />`}
        </div>`}
      </div>
      ${showAI && html`<${AIPanel} sheet=${!wide} root=${st.root} />`}
    </div>
  </div>`;
}

function TerminalRunner({ root, runCmd }) {
  const ref = useRef();
  useEffect(() => {
    if (!runCmd) return;
    const cmd = runCmd.split('#')[0];
    setTimeout(() => { const inp = ref.current?.querySelector('.jterm-input input'); if (inp) { const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(inp, cmd); inp.dispatchEvent(new Event('input', { bubbles: true })); inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); } }, 60);
  }, [runCmd]);
  return html`<div ref=${ref} style="flex:1;display:flex;flex-direction:column;min-height:0"><${Terminal} id="code" cwd=${root} /></div>`;
}

// Completion text for ghost text: FIM on coder models through llama.cpp, a short chat prompt elsewhere.
async function fetchCompletion(ref, prefix, suffix, signal, path) {
  const p = parseRef(ref);
  if (p?.type === 'local') {
    const eng = await getEngine(ref);
    if (eng.complete && /coder/i.test(ref)) return (await eng.complete({ prompt: `<|fim_prefix|>${prefix}<|fim_suffix|>${suffix}<|fim_middle|>`, maxTokens: 64, signal })).split('\n\n')[0];
  }
  const r = await chat(ref, { system: 'You are a code completion engine. Output only the code that continues at <CURSOR>: at most 3 lines, no explanations, no code fences.', messages: [{ role: 'user', content: `${path}\n${prefix}<CURSOR>${suffix}` }], maxTokens: 80, signal, thinking: 'off' });
  return textOf(r.content).replace(/^```\w*\n?|```$/g, '');
}

function AIPanel({ sheet, root }) {
  const session = useStore(current, c => c.code);
  const st = useStore(codeStore, s => ({ active: s.active, _ctx: s._ctx }));
  const [full, setFull] = useState(false);
  useEffect(() => { if (!session) getSession('code').then(s => { if (s.s.mode === 'ask' && !s.s.messages.length) s.setMode('acceptEdits'); }); }, [session]);
  useEffect(() => { if (session && session.cwd !== root) session.setCwd(root); }, [session, root]);
  if (!session) return html`<div class=${'aipanel' + (sheet ? ' sheet-mode' : '')}><div class="center grow"><div class="spinner"></div></div></div>`;
  session.extraSystem = `# Code editor context\nYou are the AI assistant inside the Code tab (an IDE). Edits you make are shown to the user as reviewable diffs in the editor.${st.active ? `\nThe user has ${st.active} open.` : ''}`;
  const ui = makeUi('code', session);
  const send = async (t, a) => {
    const ctx = codeStore.get()._ctx;
    if (ctx?.text) { a = [{ type: 'text', text: `<selection path="${ctx.path}">\n${ctx.text}\n</selection>` }, ...a]; codeStore.set({ _ctx: null }); }
    else if (st.active && !/@/.test(t) && !t.startsWith('/') && !t.startsWith('!')) t = `${t}\n\n(Current file: @${vfs.relative(session.cwd, st.active)})`;
    return handleSubmit(session, t, a, ui);
  };
  const ss = useStore(session.store, s => ({ mode: s.mode }));
  const mode = MODES.find(m => m.id === ss.mode);
  return html`<div class=${'aipanel' + (sheet ? ' sheet-mode' : '') + (full ? ' full' : '')}>
    <div class="aipanel-head"><${Icon} name="sparkles" size=${16} /><b class="grow">AI</b>
      <button class="chip sm" onClick=${() => session.setMode(nextMode(ss.mode))} title=${mode.hint}>${mode.short}</button>
      <button class="ibtn sm" onClick=${() => newSession('code')} aria-label="New chat"><${Icon} name="plus" /></button>
      ${sheet && html`<button class="ibtn sm" onClick=${() => setFull(!full)} aria-label="Expand"><${Icon} name="maximize" /></button>`}
      <button class="ibtn sm" onClick=${() => codeStore.set({ ai: false })} aria-label="Close"><${Icon} name="x" /></button></div>
    <${Transcript} session=${session} key=${session.id} welcome=${html`<div class="empty" style="padding:20px 10px"><${Icon} name="sparkles" /><h3>Build with AI</h3><div class="small">Ask for features, fixes or explanations. Edits appear in the editor for review. Select code and tap Edit for quick changes.</div></div>`} />
    ${st._ctx?.text && html`<div class="context-chips"><span class="chip sm on"><${Icon} name="code" />selection from ${st._ctx.path.split('/').pop()}</span></div>`}
    <${ModelStatus} />
    <${Composer} session=${session} kind="code" placeholder="Ask, or describe a change…" onSubmit=${send} />
  </div>`;
}
