// Chat tab: a clean conversational assistant (Think, DeepSearch, voice mode, personas, feedback → training data).
import { html, useState, useEffect, useRef, useMemo } from '../../../vendor/preact.mjs';
import { useStore } from '../../core/store.js';
import { Icon } from '../icons.js';
import { Markdown, openMenu, toast, copyText, openOverlay, confirmDialog } from '../kit.js';
import { current, getSession, newSession, openSession, removeSession, sessionsIndex, ensureIndex } from '../../agent/manager.js';
import { Composer } from '../session/composer.js';
import { PromptView } from '../session/prompts.js';
import { blocks, textOf } from '../../models/content.js';
import { modelLabel, chatModels, parseRef, modelsStore } from '../../models/registry.js';
import { openModelPicker, ModelStatus } from '../pickers.js';
import { settings, setSetting } from '../../core/settings.js';
import { relTime } from '../../core/util.js';
import { speak, stopSpeaking, listen, voiceStore } from '../../models/speech.js';
import * as vfs from '../../core/vfs.js';
import { bus } from '../../core/bus.js';
import { showTab } from '../layout.js';

const DEFAULT_PERSONAS = [
  { id: 'default', name: 'Assistant', icon: 'sparkles', prompt: 'You are a warm, sharp and concise assistant. Answer directly, then add useful detail. Use Markdown when it helps.' },
  { id: 'companion', name: 'Companion', icon: 'chat', prompt: 'You are a friendly, witty companion. Be casual and curious, keep replies short and conversational, ask follow-up questions.' },
  { id: 'tutor', name: 'Tutor', icon: 'book', prompt: 'You are a patient tutor. Explain step by step with simple examples, check understanding, and never just give answers to homework without teaching.' },
  { id: 'coder', name: 'Coder', icon: 'code', prompt: 'You are an expert programmer. Give working code first, then a brief explanation. Prefer modern, idiomatic solutions.' },
  { id: 'writer', name: 'Writer', icon: 'edit', prompt: 'You are a skilled editor and writer. Improve clarity and flow, keep the author\'s voice, and explain significant changes briefly.' },
  { id: 'unfiltered', name: 'Blunt', icon: 'bolt', prompt: 'You are candid and blunt. No fluff, no hedging, give your honest opinion with reasons. Stay respectful.' },
];

async function loadPersonas() {
  const custom = await vfs.readJSON('/settings/personas.json', null);
  return custom?.personas?.length ? custom.personas : DEFAULT_PERSONAS;
}

const CHAT_TOOLS = ['Recall', 'Memory'];
const SEARCH_TOOLS = ['Recall', 'Memory', 'WebSearch', 'WebFetch'];

function configure(session, { search, persona, think }) {
  session.allowedTools = search ? SEARCH_TOOLS : CHAT_TOOLS;
  session.extraSystem = `# Chat mode\nYou are chatting with the user in the Chat tab (not a coding session). ${persona?.prompt || ''}\n${search ? 'DeepSearch is ON: research the question with several WebSearch queries and WebFetch on the best sources, then answer with inline citations as markdown links.' : 'Only use tools when they clearly help (Recall to check memory, Memory to save something the user asks you to remember).'}`;
  session.set({ mode: 'auto' });
  session._think = think;
}

export function ChatView({ pane, active }) {
  const session = useStore(current, c => c.chat);
  useEffect(() => { if (!session) getSession('chat'); }, [session]);
  if (!session) return html`<div class="center grow"><div class="spinner"></div></div>`;
  return html`<${ChatInner} session=${session} key=${session.id} />`;
}

function ChatInner({ session }) {
  const st = useStore(session.store);
  const cfg = useStore(settings, s => s.chat);
  const [personas, setPersonas] = useState(DEFAULT_PERSONAS);
  const [search, setSearch] = useState(false);
  const [think, setThink] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const [voice, setVoice] = useState(false);
  const persona = personas.find(p => p.id === (st.persona || cfg.persona)) || personas[0];
  const scroller = useRef();
  useStore(modelsStore, s => s.local.length);
  useEffect(() => { loadPersonas().then(setPersonas); }, []);
  useEffect(() => { configure(session, { search, persona, think }); }, [search, persona, think, session]);
  useEffect(() => { const el = scroller.current; if (el) el.scrollTop = el.scrollHeight; }, [st.messages.length, st.live?.text, st.live?.thinking]);
  const ref = session.s.model || session.modelRef();

  const send = async (text, atts) => {
    if (!text && !atts.length) return;
    if (text.startsWith('/')) { const { handleSubmit } = await import('../session/submit.js'); return handleSubmit(session, text, atts, { print: (t) => session.notice(t), newSession: () => newSession('chat'), openModelPicker: pickModel, openSessions: () => setDrawer(true), openSettings: () => import('../settings/settings-view.js').then(m => m.openSettings()) }); }
    configure(session, { search, persona, think });
    const prevThinking = settings.get().agent.thinking;
    await session.send(text, { attachments: atts });
    const last = [...session.s.messages].reverse().find(m => m.role === 'assistant');
    if (last && settings.get().chat?.speakReplies) speak(textOf(last.content));
  };
  const pickModel = () => openModelPicker({ current: st.model, allowDefault: true, onPick: (r) => session.setModel(r) });

  const regenerate = async (idx) => {
    // Remove the assistant turn(s) after the last user prompt before idx and run again; keep the old answer as a "rejected" candidate.
    const msgs = session.s.messages;
    let u = idx; while (u >= 0 && !(msgs[u].role === 'user' && !blocks(msgs[u].content).some(b => b.type === 'tool_result'))) u--;
    if (u < 0) return;
    session._lastRejected = { prompt: textOf(msgs[u].content), answer: textOf(msgs[idx].content) };
    session.set({ messages: msgs.slice(0, u + 1) });
    configure(session, { search, persona, think });
    await session.loop();
  };

  const feedback = async (idx, good) => {
    const msgs = session.s.messages;
    let u = idx; while (u >= 0 && msgs[u].role !== 'user') u--;
    const prompt = textOf(msgs[u]?.content || '');
    const answer = textOf(msgs[idx].content);
    const { addPreference } = await import('../../studio/datasets.js');
    const { appendRows, createDataset } = await import('../../studio/datasets.js');
    if (good && session._lastRejected?.prompt === prompt) { await addPreference({ prompt, chosen: answer, rejected: session._lastRejected.answer }); toast('Saved as a preference pair (datasets/chat-preferences)', 'ok'); }
    else {
      const name = good ? 'chat-liked' : 'chat-disliked';
      if (!(await vfs.exists(`/datasets/${name}/meta.json`))) await createDataset(name, { type: 'sft', description: good ? 'Replies you liked in Chat (SFT data)' : 'Replies you disliked in Chat' });
      await appendRows(name, [{ messages: [{ role: 'user', content: prompt }, { role: 'assistant', content: answer }] }]);
      toast(good ? 'Thanks! Saved to datasets/chat-liked for fine-tuning.' : 'Noted. Tap regenerate, then 👍 the better answer to make a preference pair.', 'ok');
    }
  };

  const visible = st.messages.map((m, i) => [m, i]).filter(([m]) => !(m.role === 'user' && blocks(m.content).every(b => b.type === 'tool_result')) && !m._meta);
  const groups = []; // merge consecutive assistant messages (tool rounds) into one turn
  for (const [m, i] of visible) {
    const last = groups[groups.length - 1];
    if (m.role === 'assistant' && last?.role === 'assistant') last.items.push([m, i]);
    else groups.push({ role: m.role, items: [[m, i]] });
  }

  return html`<div class="chat">
    <div class="phead chat-head">
      <button class="ibtn" onClick=${() => setDrawer(true)} aria-label="History"><${Icon} name="menu" /></button>
      <button class="model-pill" onClick=${pickModel}><span class="ellipsis">${ref ? modelLabel(ref) : 'Choose model'}</span><${Icon} name="chevronDown" size=${16} /></button>
      <button class="ibtn" onClick=${() => newSession('chat')} aria-label="New chat"><${Icon} name="edit" /></button>
    </div>
    ${!groups.length ? html`<div class="chat-empty">
        <div class="logo"><${Icon} name="logo" /></div>
        <h1>What do you want to know?</h1>
        <div class="sub">${parseRef(ref)?.type === 'local' ? 'Private · runs on your phone' : ref ? 'Cloud model · online' : 'Download a model to start'}</div>
        ${!chatModels().length && html`<button class="btn primary" onClick=${() => { showTab('studio'); setTimeout(() => bus.emit('studio-tab', 'models'), 50); }}><${Icon} name="download" />Get a model</button>`}
        <div class="starters">
          ${[['Explain', 'how vaccines train the immune system'], ['Plan', 'a 3-day trip to Kyoto on a budget'], ['Write', 'a kind note declining a meeting'], ['Brainstorm', 'names for a coffee truck']].map(([a, b]) => html`<button class="starter" onClick=${() => send(`${a} ${b}`, [])}><b>${a}</b>${b}</button>`)}
        </div>
      </div>`
    : html`<div class="chat-scroll" ref=${scroller}><div class="chat-inner">
      ${groups.map(g => g.role === 'user' ? html`<${UserBubble} m=${g.items[0][0]} />` : html`<${AiTurn} items=${g.items} session=${session} onRegen=${() => regenerate(g.items[g.items.length - 1][1])} onFeedback=${(good) => feedback(g.items[g.items.length - 1][1], good)} />`)}
      ${st.live && html`<${LiveTurn} live=${st.live} search=${search} />`}
      ${st.pending && html`<${PromptView} session=${session} pending=${st.pending} />`}
      ${st.error && html`<div class="err-box"><${Icon} name="alert" /><div class="grow">${st.error}<div style="margin-top:8px"><button class="btn sm" onClick=${() => { session.set({ error: null }); session.loop(); }}>Try again</button></div></div></div>`}
      ${st.notices.slice(-1).map(n => n.kind === 'interrupt' ? null : html`<div class="dim small" style="margin-bottom:12px">${n.text}</div>`)}
    </div></div>`}
    <${ModelStatus} />
    <div class="chat-composer"><div class="chat-wrap-max">
      <${Composer} session=${session} kind="chat" placeholder=${search ? 'Research anything…' : 'Ask anything'} onSubmit=${send} />
      <div class="chat-modes">
        <button class=${'chip' + (search ? ' on' : '')} onClick=${() => setSearch(!search)}><${Icon} name="globe" />DeepSearch</button>
        <button class=${'chip' + (think ? ' on' : '')} onClick=${() => { setThink(!think); setSetting('agent.thinking', !think ? 'on' : 'auto'); }}><${Icon} name="brain" />Think</button>
        <button class="chip" onClick=${() => setVoice(true)}><${Icon} name="waveform" />Voice</button>
        <button class="chip" onClick=${(e) => openMenu(e.currentTarget, [{ label: 'Persona' }, ...personas.map(p => ({ icon: p.icon || 'user', text: p.name, selected: p.id === persona.id, onClick: () => { session.set({ persona: p.id }); setSetting('chat.persona', p.id); } })), '-', { icon: 'edit', text: 'Edit personas…', onClick: async () => { await vfs.ensureFile('/settings/personas.json', JSON.stringify({ personas: DEFAULT_PERSONAS }, null, 2)); bus.emit('open-file', { path: '/settings/personas.json' }); } }])}><${Icon} name=${persona.icon || 'user'} />${persona.name}<${Icon} name="chevronDown" size=${13} /></button>
      </div>
    </div></div>
    ${drawer && html`<${HistoryDrawer} session=${session} close=${() => setDrawer(false)} />`}
    ${voice && html`<${VoiceMode} session=${session} send=${send} close=${() => { setVoice(false); stopSpeaking(); session.stop(); }} />`}
  </div>`;
}

function UserBubble({ m }) {
  const bl = blocks(m.content);
  const text = bl.filter(b => b.type === 'text' && !b.text.startsWith('<file path=')).map(b => b.text).join('\n');
  const files = bl.filter(b => b.type === 'text' && b.text.startsWith('<file path=')).map(b => /<file path="([^"]+)"/.exec(b.text)?.[1]?.split('/').pop());
  return html`<div class="msg user"><div class="bubble">${bl.filter(b => b.type === 'image').map(b => html`<img src=${`data:${b.source.media_type};base64,${b.source.data}`} alt="" />`)}${files.map(f => html`<div class="tag" style="margin-bottom:4px"><${Icon} name="file" size=${12} />${f}</div>`)}${text}</div></div>`;
}

function AiTurn({ items, session, onRegen, onFeedback }) {
  const all = items.flatMap(([m]) => blocks(m.content));
  const thinking = all.filter(b => b.type === 'thinking').map(b => b.thinking).join('\n').trim();
  const steps = all.filter(b => b.type === 'tool_use' || b.type === 'server_tool_use');
  const text = all.filter(b => b.type === 'text').map(b => b.text).join('\n\n');
  const sources = [];
  for (const b of all) if (b.type === 'web_search_tool_result' && Array.isArray(b.content)) sources.push(...b.content.map(r => ({ title: r.title, url: r.url })));
  for (const b of all) if (b.type === 'tool_use' && b.name === 'WebFetch') sources.push({ title: b.input.url, url: b.input.url });
  const ms = items.reduce((a, [m]) => a + (m._ms || 0), 0);
  return html`<div class="msg ai">
    ${thinking && html`<details class="thought"><summary><${Icon} name="brain" size=${14} />Thought${ms ? ` for ${Math.max(1, Math.round(ms / 1000))}s` : ''}</summary><div>${thinking}</div></details>`}
    ${steps.length > 0 && html`<div class="search-steps">${steps.map(s => html`<div class="step"><${Icon} name=${/Search|search/.test(s.name) ? 'search' : s.name === 'WebFetch' ? 'globe' : s.name === 'Recall' ? 'brain' : 'wrench'} />${s.name === 'WebSearch' || s.type === 'server_tool_use' ? `Searched “${s.input?.query}”` : s.name === 'WebFetch' ? `Read ${(() => { try { return new URL(s.input.url).hostname; } catch { return s.input.url; } })()}` : s.name === 'Recall' ? `Checked memory for “${s.input.query}”` : s.name === 'Memory' ? 'Saved to memory' : s.name}</div>`)}</div>`}
    <${Markdown} text=${text || '…'} />
    ${sources.length > 0 && html`<div class="sources">${sources.slice(0, 8).map(s => html`<a class="source" href=${s.url} target="_blank" rel="noopener"><${Icon} name="link" size=${12} /><span>${(() => { try { return new URL(s.url).hostname.replace(/^www\./, ''); } catch { return s.title; } })()}</span></a>`)}</div>`}
    <div class="msg-actions">
      <button class="ibtn" onClick=${() => copyText(text)} aria-label="Copy"><${Icon} name="copy" /></button>
      <button class="ibtn" onClick=${() => speak(text)} aria-label="Read aloud"><${Icon} name="speaker" /></button>
      <button class="ibtn" onClick=${onRegen} aria-label="Regenerate"><${Icon} name="refresh" /></button>
      <button class="ibtn" onClick=${() => onFeedback(true)} aria-label="Good answer"><${Icon} name="thumbUp" /></button>
      <button class="ibtn" onClick=${() => onFeedback(false)} aria-label="Bad answer"><${Icon} name="thumbDown" /></button>
      ${ms ? html`<span class="meta">${(ms / 1000).toFixed(1)}s</span>` : ''}
    </div>
  </div>`;
}

function LiveTurn({ live, search }) {
  return html`<div class="msg ai">
    ${live.thinking && html`<details class="thought" open><summary><${Icon} name="brain" size=${14} />Thinking…</summary><div>${live.thinking.slice(-2500)}</div></details>`}
    ${live.calls?.length > 0 && html`<div class="search-steps">${live.calls.map(c => html`<div class="step"><div class="spinner" style="width:13px;height:13px"></div>${c.name === 'WebSearch' ? 'Searching…' : c.name === 'WebFetch' ? 'Reading a page…' : c.name + '…'}</div>`)}</div>`}
    ${live.status && html`<div class="search-steps"><div class="step"><div class="spinner" style="width:13px;height:13px"></div>${live.status}</div></div>`}
    ${live.text ? html`<${Markdown} text=${live.text} />` : html`<div class="typing"><i></i><i></i><i></i></div>`}
  </div>`;
}

function HistoryDrawer({ session, close }) {
  const { list } = useStore(sessionsIndex);
  const [q, setQ] = useState('');
  useEffect(() => { ensureIndex(); }, []);
  const items = list.filter(s => s.kind === 'chat' && (!q || s.title.toLowerCase().includes(q.toLowerCase())));
  const day = 86400000, now = Date.now();
  const groups = [['Today', items.filter(s => now - s.updated < day)], ['This week', items.filter(s => now - s.updated >= day && now - s.updated < 7 * day)], ['Older', items.filter(s => now - s.updated >= 7 * day)]];
  return html`<div class="scrim" onClick=${close}></div><div class="drawer">
    <div class="drawer-head"><input class="input" placeholder="Search chats" value=${q} onInput=${e => setQ(e.target.value)} /><button class="ibtn" onClick=${() => { newSession('chat'); close(); }} aria-label="New chat"><${Icon} name="edit" /></button></div>
    <div class="drawer-body">${groups.map(([g, l]) => l.length ? html`<div class="group">${g}</div>${l.map(s => html`<div class="row"><button class=${'hist grow' + (s.id === session.id ? ' on' : '')} onClick=${() => { openSession('chat', s.id); close(); }}>${s.title}</button>
      <button class="ibtn sm" onClick=${async () => { if (await confirmDialog({ title: 'Delete chat?', message: s.title, ok: 'Delete', danger: true })) removeSession('chat', s.id); }} aria-label="Delete"><${Icon} name="trash" /></button></div>`)}` : null)}
      ${!items.length && html`<div class="empty small">No chats yet</div>`}</div></div>`;
}

function VoiceMode({ session, send, close }) {
  const [state, setState] = useState('listening'); // listening | thinking | speaking | paused
  const [text, setText] = useState('');
  const alive = useRef(true);
  const ctrl = useRef(null);
  const loop = async () => {
    while (alive.current) {
      setState('listening'); setText('');
      ctrl.current = new AbortController();
      let heard = '';
      try { heard = await listen({ onPartial: setText, signal: ctrl.current.signal }); } catch (e) { setText(String(e.message || e)); setState('paused'); return; }
      if (!alive.current) return;
      if (!heard?.trim()) { setState('paused'); setText('Tap the mic to talk'); return; }
      setText(heard); setState('thinking');
      await session.send(heard);
      if (!alive.current) return;
      const last = [...session.s.messages].reverse().find(m => m.role === 'assistant');
      const reply = last ? textOf(last.content) : '';
      setText(reply); setState('speaking');
      await new Promise(res => speak(reply, { onEnd: res }));
    }
  };
  useEffect(() => { loop(); return () => { alive.current = false; ctrl.current?.abort(); }; }, []);
  return html`<div class="voice">
    <div class="voice-state">${{ listening: 'Listening', thinking: 'Thinking', speaking: 'Speaking', paused: 'Paused' }[state]}</div>
    <div class=${'orb ' + state}></div>
    <div class="voice-text">${text}</div>
    <div class="voice-controls">
      <button class="ibtn" onClick=${() => { if (state === 'speaking') { stopSpeaking(); } else if (state === 'paused') loop(); else ctrl.current?.abort(); }} aria-label="Talk"><${Icon} name=${state === 'speaking' ? 'stop' : 'mic'} /></button>
      <button class="ibtn end" onClick=${close} aria-label="End voice mode"><${Icon} name="x" /></button>
    </div>
  </div>`;
}
