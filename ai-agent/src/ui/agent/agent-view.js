// Agent tab: a Claude Code–style agent in a terminal-like transcript.
import { html, useState, useEffect } from '../../../vendor/preact.mjs';
import { useStore } from '../../core/store.js';
import { Icon } from '../icons.js';
import { openMenu, toast } from '../kit.js';
import { current, getSession, newSession, openSession, removeSession } from '../../agent/manager.js';
import { Transcript } from '../session/transcript.js';
import { Composer } from '../session/composer.js';
import { handleSubmit } from '../session/submit.js';
import { MODES, nextMode } from '../../agent/permissions.js';
import { modelLabel, contextWindow, chatModels, modelsStore } from '../../models/registry.js';
import { openModelPicker, openProjectPicker, openSessions, ModelStatus } from '../pickers.js';
import { openSettings } from '../settings/settings-view.js';
import { exportMarkdown } from '../../agent/commands.js';
import { bus } from '../../core/bus.js';
import { env } from '../../core/platform.js';
import { showTab } from '../layout.js';

export function useSurfaceSession(kind) {
  const s = useStore(current, c => c[kind]);
  useEffect(() => { if (!s) getSession(kind); }, [s]);
  return s;
}

export function makeUi(kind, session) {
  return {
    print: (t) => session.notice(t),
    newSession: () => newSession(kind),
    openModelPicker: () => openModelPicker({ current: session.s.model, allowDefault: true, onPick: (r) => session.setModel(r) }),
    openSessions: () => openSessions({ kind, currentId: session.id, onOpen: (id) => openSession(kind, id), onDelete: (id) => removeSession(kind, id), onNew: () => newSession(kind) }),
    openSettings: (section) => openSettings(section),
  };
}

function StatusLine({ session }) {
  const st = useStore(session.store, s => ({ mode: s.mode, model: s.model, cwd: s.cwd, msgs: s.messages.length, usage: s.usage }));
  useStore(modelsStore, s => s.local.length);
  const online = useStore(env, s => s.online);
  const mode = MODES.find(m => m.id === st.mode) || MODES[0];
  const ref = session.modelRef();
  const pct = st.msgs ? Math.min(100, Math.round(session.estimateTokens() / contextWindow(ref) * 100)) : 0;
  const glyph = { ask: '⏸', acceptEdits: '⏵⏵', plan: '⏸', auto: '⏵⏵⏵' }[mode.id];
  return html`<div class="statusline">
    <button class="mode-chip" style=${`--mode-color:${mode.color}`} onClick=${() => session.setMode(nextMode(st.mode))} title=${mode.hint}>${glyph} ${mode.short}${mode.id !== 'ask' ? ' on' : ''}</button>
    <span class="sep">·</span>
    <button onClick=${() => makeUi('agent', session).openModelPicker()}><${Icon} name=${ref.startsWith('cloud') ? 'cloud' : 'cpu'} size=${12} />${ref ? modelLabel(ref) : 'no model'}</button>
    <span class="sep">·</span><span>${pct}% context</span>
    ${st.usage.cost ? html`<span class="sep">·</span><span>$${st.usage.cost.toFixed(3)}</span>` : ''}
    ${!online && html`<span class="sep">·</span><span class="warn">offline</span>`}
  </div>`;
}

function Welcome({ session }) {
  const st = useStore(session.store, s => ({ cwd: s.cwd }));
  useStore(modelsStore, s => s.local.length);
  const models = chatModels();
  const ask = (t) => handleSubmit(session, t, [], makeUi('agent', session));
  return html`<div class="welcome">
    <div class="welcome-title"><span class="spark">✻</span> Welcome to Ai Agent</div>
    <div class="dim">cwd: ${st.cwd}</div>
    ${!models.length && html`<div class="banner warn" style="margin-top:10px;font-family:var(--font)"><${Icon} name="alert" /><div class="grow">No model yet. <a href="#" onClick=${(e) => { e.preventDefault(); showTab('studio'); setTimeout(() => bus.emit('studio-tab', 'models'), 50); }}>Download one</a> (Qwen3 4B Instruct is a good start, 2.5 GB) or add a cloud API key in Settings.</div></div>`}
    <ul class="tips">
      <li><b>/help</b> commands · <b>/init</b> write AGENT.md · <b>/plan</b> plan first</li>
      <li><b>!</b> run a shell command · <b>#</b> remember something · <b>@</b> attach a file</li>
      <li>Tap the mode in the status line to cycle: ask → accept edits → plan → auto</li>
    </ul>
    <div class="quick">
      <button class="chip" onClick=${() => ask('What is in this project? Give me a short overview.')}><${Icon} name="search" />Explore project</button>
      <button class="chip" onClick=${() => ask('Build a small, polished single-page web app here: a tip calculator with dark mode. Then open the preview.')}><${Icon} name="code" />Build a web app</button>
      <button class="chip" onClick=${() => ask('Create a Python script that analyzes a CSV of expenses (generate sample data), plots monthly totals, and saves the chart.')}><${Icon} name="chart" />Analyze data</button>
      <button class="chip" onClick=${() => ask('Help me plan a fine-tune of a small model on my own writing style. What data do I need?')}><${Icon} name="flask" />Train a model</button>
    </div>
  </div>`;
}

export function AgentView({ pane, active }) {
  const session = useSurfaceSession('agent');
  if (!session) return html`<div class="center grow"><div class="spinner"></div></div>`;
  return html`<${AgentInner} session=${session} key=${session.id} />`;
}

function AgentInner({ session }) {
  const st = useStore(session.store, s => ({ title: s.title, cwd: s.cwd, status: s.status }));
  const ui = makeUi('agent', session);
  useEffect(() => bus.on('share', ({ title, text, url }) => { const t = [title, text, url].filter(Boolean).join('\n'); if (t) session.send(t); }), [session]);
  const more = (e) => openMenu(e.currentTarget, [
    { icon: 'plus', text: 'New session', onClick: () => newSession('agent') },
    { icon: 'history', text: 'History', onClick: ui.openSessions },
    { icon: 'cpu', text: 'Model…', onClick: ui.openModelPicker },
    '-',
    { icon: 'layers', text: 'Compact conversation', onClick: () => session.compact().then(() => toast('Compacted', 'ok')).catch(e => toast(e.message, 'err')) },
    { icon: 'undo', text: 'Rewind last turn', onClick: () => session.rewind().then(n => toast(n ? `Restored ${n} file(s)` : 'Nothing to rewind')) },
    { icon: 'share', text: 'Export as Markdown', onClick: async () => { const t = exportMarkdown(session); try { await navigator.share({ title: session.s.title, text: t }); } catch { navigator.clipboard?.writeText(t); toast('Copied transcript', 'ok'); } } },
    '-',
    { icon: 'settings', text: 'Settings', onClick: () => openSettings() },
  ], { align: 'right' });
  return html`<div class="agent">
    <div class="phead">
      <button class="btn ghost sm" style="padding:0 6px;min-width:0" onClick=${() => openProjectPicker({ current: st.cwd, onPick: (p) => { session.setCwd(p); toast(`Working in ${p}`); } })}>
        <${Icon} name="folder" /><span class="ellipsis" style="max-width:38vw">${st.cwd === '/' ? 'Hub' : st.cwd.split('/').pop()}</span><${Icon} name="chevronDown" size=${14} /></button>
      <div class="grow ellipsis phead-sub" style="text-align:center">${st.title !== 'New session' ? st.title : ''}</div>
      <button class="ibtn sm" onClick=${() => newSession('agent')} aria-label="New session"><${Icon} name="plus" /></button>
      <button class="ibtn sm" onClick=${ui.openSessions} aria-label="History"><${Icon} name="history" /></button>
      <button class="ibtn sm" onClick=${more} aria-label="More"><${Icon} name="moreV" /></button>
    </div>
    <${Transcript} session=${session} welcome=${html`<${Welcome} session=${session} />`} onRetry=${() => { session.set({ error: null }); session.loop(); }} />
    <${ModelStatus} />
    <${Composer} session=${session} kind="agent" placeholder="Tell the agent what to do…" onSubmit=${(t, a) => handleSubmit(session, t, a, ui)} statusLine=${html`<${StatusLine} session=${session} />`} />
  </div>`;
}
