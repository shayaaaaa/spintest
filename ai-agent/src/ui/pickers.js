// Shared sheets: model picker, project picker, saved sessions, model loading status.
import { html, useState, useEffect } from '../../vendor/preact.mjs';
import { useStore } from '../core/store.js';
import { Icon } from './icons.js';
import { openSheet, promptDialog, confirmDialog, Progress, toast, Empty } from './kit.js';
import { chatModels, modelsStore, refreshModels, manifestFor } from '../models/registry.js';
import { listProjects } from '../core/hub.js';
import * as vfs from '../core/vfs.js';
import { sessionsIndex, ensureIndex } from '../agent/manager.js';
import { relTime, fmtBytes } from '../core/util.js';
import { showTab } from './layout.js';
import { bus } from '../core/bus.js';

export function openModelPicker({ current, onPick, title = 'Choose a model', allowDefault = false }) {
  openSheet({ title }, (close) => html`<${ModelList} current=${current} allowDefault=${allowDefault} onPick=${(ref) => { close(); onPick(ref); }} close=${close} />`);
}

function ModelList({ current, onPick, allowDefault, close }) {
  useStore(modelsStore, s => s.local.length);
  useEffect(() => { refreshModels(); }, []);
  const list = chatModels();
  const local = list.filter(m => m.local), cloud = list.filter(m => !m.local);
  const row = (m) => html`<button class="li model-row" onClick=${() => onPick(m.ref)}>
    <span class=${'li-icon ' + (m.local ? 'local' : 'cloud')}><${Icon} name=${m.local ? 'cpu' : 'cloud'} /></span>
    <div class="li-main"><div class="li-title">${m.label}</div><div class="li-sub">${m.sub}${m.local && manifestFor(m.ref)?.bytes ? ' · ' + fmtBytes(manifestFor(m.ref).bytes) : ''}${m.vision ? ' · sees images' : ''}</div></div>
    ${current === m.ref && html`<${Icon} name="check" />`}</button>`;
  return html`
    ${allowDefault && html`<div class="list" style="margin-bottom:12px"><button class="li" onClick=${() => onPick('')}><span class="li-icon"><${Icon} name="sparkles" /></span><div class="li-main"><div class="li-title">Default</div><div class="li-sub">Use the model set in Settings</div></div>${!current && html`<${Icon} name="check" />`}</button></div>`}
    <div class="section-title"><${Icon} name="cpu" size=${14} />On this phone (offline)</div>
    ${local.length ? html`<div class="list">${local.map(row)}</div>` : html`<div class="card small dim">No models downloaded yet.</div>`}
    <button class="btn block" style="margin-top:10px" onClick=${() => { close(); showTab('studio'); setTimeout(() => bus.emit('studio-tab', 'models'), 50); }}><${Icon} name="download" />Download models</button>
    <div class="section-title"><${Icon} name="cloud" size=${14} />Cloud (needs internet + your API key)</div>
    ${cloud.length ? html`<div class="list">${cloud.map(row)}</div>` : html`<div class="card small dim">Add an API key in Settings → Models & keys to use Anthropic, OpenAI, xAI, Gemini and others when you're online.</div>`}`;
}

export function ModelStatus() {
  const st = useStore(modelsStore, s => s.status);
  if (!st || st.state !== 'loading') return null;
  return html`<div class="loading-model"><div class="spinner"></div><span class="ellipsis" style="max-width:55%">${st.text || 'Loading model…'}</span><${Progress} value=${st.progress || 0} indet=${!st.progress} /></div>`;
}

export function openProjectPicker({ current, onPick }) {
  openSheet({ title: 'Projects' }, (close) => html`<${ProjectList} current=${current} onPick=${(p) => { close(); onPick(p); }} />`);
}

function ProjectList({ current, onPick }) {
  const [list, setList] = useState(null);
  const load = () => listProjects().then(setList);
  useEffect(() => { load(); }, []);
  const create = async () => {
    const name = await promptDialog({ title: 'New project', label: 'Folder name in /workspace', placeholder: 'my-app' });
    if (!name) return;
    const p = `/workspace/${name.trim().replace(/[^\w.-]+/g, '-')}`;
    if (await vfs.exists(p)) return toast('A project with that name exists', 'warn');
    await vfs.mkdir(p);
    await vfs.ensureFile(`${p}/AGENT.md`, `# ${name}\n\nDescribe this project here: what it is, how to run it, conventions.\n`);
    onPick(p);
  };
  return html`<button class="btn primary block" onClick=${create}><${Icon} name="plus" />New project</button>
    <div class="list" style="margin-top:12px">${(list || []).map(p => html`<button class="li" onClick=${() => onPick(p)}>
      <span class="li-icon"><${Icon} name="folder" /></span><div class="li-main"><div class="li-title">${p.split('/').pop()}</div><div class="li-sub">${p}</div></div>${current?.startsWith(p) && html`<${Icon} name="check" />`}</button>`)}
      <button class="li" onClick=${() => onPick('/workspace')}><span class="li-icon"><${Icon} name="folderOpen" /></span><div class="li-main"><div class="li-title">Whole workspace</div><div class="li-sub">/workspace</div></div></button>
      <button class="li" onClick=${() => onPick('/')}><span class="li-icon"><${Icon} name="layers" /></span><div class="li-main"><div class="li-title">Hub root</div><div class="li-sub">Work on memory, skills, tools and settings</div></div></button>
    </div>`;
}

export function openSessions({ kind, currentId, onOpen, onDelete, onNew }) {
  openSheet({ title: 'History' }, (close) => html`<${SessionList} kind=${kind} currentId=${currentId} onOpen=${(id) => { close(); onOpen(id); }} onDelete=${onDelete} onNew=${() => { close(); onNew(); }} />`);
}

function SessionList({ kind, currentId, onOpen, onDelete, onNew }) {
  const { list } = useStore(sessionsIndex);
  const [q, setQ] = useState('');
  useEffect(() => { ensureIndex(); }, []);
  const items = list.filter(s => s.kind === kind && (!q || s.title.toLowerCase().includes(q.toLowerCase())));
  return html`<div class="row" style="margin-bottom:10px"><input class="input" placeholder="Search conversations" value=${q} onInput=${e => setQ(e.target.value)} /><button class="btn primary" onClick=${onNew}><${Icon} name="plus" /></button></div>
    ${items.length ? html`<div class="list">${items.map(s => html`<div class="li clickable" onClick=${() => onOpen(s.id)}>
      <span class="li-icon"><${Icon} name=${kind === 'chat' ? 'chat' : 'terminal'} /></span>
      <div class="li-main"><div class="li-title">${s.title}</div><div class="li-sub">${relTime(s.updated)}${s.cwd ? ' · ' + s.cwd.replace('/workspace/', '') : ''}</div></div>
      ${s.id === currentId ? html`<${Icon} name="check" />` : html`<button class="ibtn sm" onClick=${async (e) => { e.stopPropagation(); if (await confirmDialog({ title: 'Delete conversation?', message: s.title, ok: 'Delete', danger: true })) onDelete(s.id); }} aria-label="Delete"><${Icon} name="trash" /></button>`}
    </div>`)}</div>` : html`<${Empty} icon="history" title="No conversations yet">Your conversations are saved in the Hub under chats/.<//>`}`;
}
