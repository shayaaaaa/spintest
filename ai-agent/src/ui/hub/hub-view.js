// Hub tab: everything the app knows and uses, as plain folders and files — browse, view, edit, import, share.
import { html, useState, useEffect, useRef } from '../../../vendor/preact.mjs';
import { createStore, useStore } from '../../core/store.js';
import { Icon, fileIcon } from '../icons.js';
import { openSheet, toast, promptDialog, confirmDialog, Markdown, Empty, Seg, Progress, Banner } from '../kit.js';
import * as vfs from '../../core/vfs.js';
import { fmtBytes, relTime, isTextName, extOf, mimeOf, toFrontMatter } from '../../core/util.js';
import { bus } from '../../core/bus.js';
import { env, refreshStorage } from '../../core/platform.js';
import { fileActions, newEntry, shareFile, useDirListing } from '../code/explorer.js';
import { openSettings } from '../settings/settings-view.js';
import { openFileInEditor, showTab } from '../layout.js';
import { createEditor } from '../code/editor.js';

export const hubStore = createStore({ path: null, query: '' });

const SECTIONS = [
  { path: '/memory', label: 'Memory', icon: 'brain', desc: 'MEMORY.md + notes' },
  { path: '/skills', label: 'Skills', icon: 'sparkles', desc: 'Reusable instructions' },
  { path: '/tools', label: 'Tools', icon: 'wrench', desc: 'Custom agent tools' },
  { path: '/agents', label: 'Subagents', icon: 'bot', desc: 'Specialist agents' },
  { path: '/commands', label: 'Commands', icon: 'slash', desc: 'Your /commands' },
  { path: '/knowledge', label: 'Knowledge', icon: 'book', desc: 'RAG collections' },
  { path: '/models', label: 'Models', icon: 'cpu', desc: 'LLMs, voice, vision' },
  { path: '/datasets', label: 'Datasets', icon: 'dataset', desc: 'Training data' },
  { path: '/training', label: 'Training', icon: 'flask', desc: 'Runs & checkpoints' },
  { path: '/workspace', label: 'Projects', icon: 'code', desc: 'Your code & files' },
  { path: '/chats', label: 'Chats', icon: 'chat', desc: 'Saved conversations' },
  { path: '/hooks', label: 'Hooks', icon: 'zap', desc: 'Automations' },
  { path: '/settings', label: 'Settings files', icon: 'settings', desc: 'JSON config' },
  { path: '/runtimes', label: 'Runtimes', icon: 'package', desc: 'Python, Linux, ffmpeg' },
  { path: '/inbox', label: 'Inbox', icon: 'inbox', desc: 'Imported & shared files' },
  { path: '/trash', label: 'Trash', icon: 'trash', desc: 'Deleted items' },
];

const TEMPLATES = {
  '/skills': { label: 'New skill', make: async (name) => { const p = `/skills/${name}/SKILL.md`; await vfs.write(p, toFrontMatter({ name, description: 'What this skill does and when to use it.' }, `# ${name}\n\nSteps and rules for the agent to follow.\n`)); return p; } },
  '/agents': { label: 'New subagent', make: async (name) => { const p = `/agents/${name}.md`; await vfs.write(p, toFrontMatter({ name, description: 'When the main agent should delegate to this subagent.', tools: ['Read', 'Glob', 'Grep', 'LS'] }, `You are a specialist. Describe its role, method and report format here.\n`)); return p; } },
  '/commands': { label: 'New command', make: async (name) => { const p = `/commands/${name}.md`; await vfs.write(p, toFrontMatter({ description: 'What /' + name + ' does' }, `Instructions for the agent. $ARGUMENTS is replaced by what you type after /${name}.\n`)); return p; } },
  '/tools': { label: 'New tool', make: async (name) => { const d = `/tools/${name}`; await vfs.write(`${d}/tool.json`, JSON.stringify({ name: name.replace(/(^|-)(\w)/g, (_, a, b) => b.toUpperCase()), description: 'What the tool does.', input_schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }, null, 2)); await vfs.write(`${d}/tool.js`, 'async function run(input, ctx) {\n  return { echo: input.text };\n}\n'); return `${d}/tool.js`; } },
  '/knowledge': { label: 'New collection', make: async (name) => { await vfs.mkdir(`/knowledge/${name}/docs`); await vfs.write(`/knowledge/${name}/README.md`, `Put documents in docs/ and tap Index.\n`); return null; } },
};

export function previewFile(path) { showTab('hub'); setTimeout(() => openViewer(path), 50); }
bus.on('hub-open', ({ path }) => hubStore.set({ path }));

export function HubView({ pane, active }) {
  const st = useStore(hubStore);
  return html`<div class="hub">
    <div class="phead"><div class="phead-title grow"><${Icon} name="folder" />${st.path ? (SECTIONS.find(s => s.path === st.path)?.label || vfs.basename(st.path) || 'Hub') : 'Hub'}</div>
      <button class="ibtn sm" onClick=${() => openSearch()} aria-label="Search the Hub"><${Icon} name="search" /></button>
      <button class="ibtn sm" onClick=${() => openSettings()} aria-label="Settings"><${Icon} name="settings" /></button></div>
    ${st.path == null ? html`<${HubHome} />` : st.path.startsWith('/knowledge') && st.path.split('/').length <= 3 ? html`<${KnowledgeView} path=${st.path} />` : html`<${Browser} path=${st.path} />`}
  </div>`;
}

function HubHome() {
  const e = useStore(env, s => s.storage);
  const [counts, setCounts] = useState({});
  useEffect(() => {
    refreshStorage();
    (async () => { const c = {}; for (const s of SECTIONS) c[s.path] = (await vfs.list(s.path, { details: false }).catch(() => [])).length; setCounts(c); })();
  }, []);
  return html`<div class="hub-scroll"><div class="page">
    <${Banner} icon="layers">Your Hub is a folder of plain files on this phone: models, memory, skills, tools, knowledge and projects. The agent reads and writes it too (ask it, or use / commands).<//>
    <div class="section-title">Sections</div>
    <div class="hub-grid">${SECTIONS.map(s => html`<button class="hub-card" onClick=${() => hubStore.set({ path: s.path })}><span class="ic"><${Icon} name=${s.icon} /></span><span class="t">${s.label}</span><span class="s">${counts[s.path] != null ? `${counts[s.path]} item${counts[s.path] === 1 ? '' : 's'} · ` : ''}${s.desc}</span></button>`)}</div>
    <div class="section-title">Storage</div>
    <div class="card"><div class="meter"><div style=${`width:${e.quota ? e.used / e.quota * 100 : 0}%;background:var(--accent)`}></div></div><div class="small dim" style="margin-top:6px">${fmtBytes(e.used)} used · ${fmtBytes(e.quota - e.used)} free for Ai Agent</div></div>
    <div class="row wrap" style="margin-top:12px"><button class="btn" onClick=${() => hubStore.set({ path: '/' })}><${Icon} name="folderOpen" />Browse all files</button><button class="btn" onClick=${() => importInto('/inbox')}><${Icon} name="upload" />Import files</button><button class="btn" onClick=${() => openFileInEditor('/memory/MEMORY.md')}><${Icon} name="brain" />Edit MEMORY.md</button></div>
  </div></div>`;
}

async function importInto(dir) {
  const inp = Object.assign(document.createElement('input'), { type: 'file', multiple: true });
  inp.onchange = async () => {
    let n = 0;
    for (const f of inp.files) {
      if (/\.zip$/i.test(f.name) && await confirmDialog({ title: `Extract ${f.name}?`, message: `Unzip into ${dir}, or keep the .zip as a file.`, ok: 'Extract', cancel: 'Keep zip' })) {
        const { JSZip } = await import('../../../vendor/office.mjs');
        const z = await JSZip.loadAsync(f);
        for (const [name, entry] of Object.entries(z.files)) { if (!entry.dir) { await vfs.write(vfs.join(dir, name), await entry.async('uint8array')); n++; } }
      } else { await vfs.write(vfs.join(dir, f.name), f); n++; }
    }
    toast(`Imported ${n} file${n === 1 ? '' : 's'} into ${dir}`, 'ok');
  };
  inp.click();
}

function Crumbs({ path }) {
  const parts = path.split('/').filter(Boolean);
  return html`<div class="crumbs"><button onClick=${() => hubStore.set({ path: null })}><${Icon} name="layers" size=${14} /></button><span class="sep">/</span>
    ${parts.map((p, i) => html`<button onClick=${() => hubStore.set({ path: '/' + parts.slice(0, i + 1).join('/') })}>${p}</button>${i < parts.length - 1 && html`<span class="sep">/</span>`}`)}</div>`;
}

function Browser({ path }) {
  const items = useDirListing(path);
  const tpl = TEMPLATES[path];
  const [sort, setSort] = useState('name');
  const sorted = (items || []).slice().sort((a, b) => a.kind !== b.kind ? (a.kind === 'directory' ? -1 : 1) : sort === 'date' ? (b.mtime || 0) - (a.mtime || 0) : sort === 'size' ? (b.size || 0) - (a.size || 0) : a.name.localeCompare(b.name, undefined, { numeric: true }));
  const open = (e) => e.kind === 'directory' ? hubStore.set({ path: e.path }) : openViewer(e.path);
  return html`<${Crumbs} path=${path} />
    <div class="hub-scroll"><div class="page">
      <div class="row wrap" style="margin-bottom:10px">
        ${tpl && html`<button class="btn primary sm" onClick=${async () => { const n = await promptDialog({ title: tpl.label, label: 'Name (lowercase, dashes)', placeholder: 'my-thing' }); if (!n) return; const p = await tpl.make(n.trim().toLowerCase().replace(/[^\w-]+/g, '-')); if (p) openViewer(p); }}><${Icon} name="plus" />${tpl.label}</button>`}
        <button class="btn sm" onClick=${() => newEntry(path, 'file', openViewer)}><${Icon} name="file" />File</button>
        <button class="btn sm" onClick=${() => newEntry(path, 'directory')}><${Icon} name="folder" />Folder</button>
        <button class="btn sm" onClick=${() => importInto(path)}><${Icon} name="upload" />Import</button>
        <span class="spacer"></span>
        <${Seg} value=${sort} onChange=${setSort} options=${[{ value: 'name', label: 'A–Z' }, { value: 'date', label: 'Recent' }, { value: 'size', label: 'Size' }]} />
      </div>
      ${items && !items.length ? html`<${Empty} icon="folderOpen" title="Empty folder">Import files, or ask the agent to create something here.<//>` : html`<div class="list">${sorted.map(e => html`
        <div class="li clickable fl-item" onClick=${() => open(e)} onContextMenu=${(ev) => { ev.preventDefault(); fileActions({ x: ev.clientX, y: ev.clientY }, e, { onOpen: openViewer }); }}>
          <span class=${'li-icon' + (e.kind === 'directory' ? ' dir' : '')}><${Icon} name=${fileIcon(e.name, e.kind)} /></span>
          <div class="li-main"><div class="li-title">${e.name}</div><div class="li-sub">${e.kind === 'directory' ? 'Folder' : `${fmtBytes(e.size)} · ${relTime(e.mtime)}`}</div></div>
          <button class="ibtn sm" onClick=${(ev) => { ev.stopPropagation(); fileActions(ev.currentTarget, e, { onOpen: openViewer }); }} aria-label="Actions"><${Icon} name="more" /></button>
        </div>`)}</div>`}
    </div></div>`;
}

// ---------- file viewer/editor sheet ----------
export function openViewer(path) {
  openSheet({ title: vfs.basename(path), wide: true, actions: html`<button class="ibtn sm" onClick=${() => shareFile(path)} aria-label="Share"><${Icon} name="share" /></button>` }, (close) => html`<${Viewer} path=${path} close=${close} />`);
}

function Viewer({ path, close }) {
  const ext = extOf(path);
  const [url, setUrl] = useState(null);
  const [mode, setMode] = useState(ext === 'md' ? 'preview' : 'edit');
  const [text, setText] = useState(null);
  const [dirty, setDirty] = useState(false);
  const host = useRef(); const ed = useRef();
  const text_ = isTextName(path);
  useEffect(() => {
    let u;
    if (text_) vfs.readText(path).then(setText).catch(() => setText(''));
    else vfs.getFile(path).then(f => { u = URL.createObjectURL(new Blob([f], { type: mimeOf(path) })); setUrl(u); });
    return () => u && URL.revokeObjectURL(u);
  }, [path]);
  useEffect(() => {
    if (!text_ || text == null || mode !== 'edit' || !host.current) return;
    ed.current = createEditor(host.current, { doc: text, path, onChange: () => setDirty(true), onSave: () => save() });
    return () => { ed.current?.destroy(); ed.current = null; };
  }, [text != null, mode]);
  const save = async () => { if (!ed.current) return; const t = ed.current.state.doc.toString(); await vfs.write(path, t); setText(t); setDirty(false); toast('Saved', 'ok'); };
  if (text_) return html`<div class="viewer">
    <div class="row" style="margin-bottom:8px">${ext === 'md' && html`<${Seg} value=${mode} onChange=${(m) => { if (ed.current) setText(ed.current.state.doc.toString()); setMode(m); }} options=${[{ value: 'preview', label: 'Preview' }, { value: 'edit', label: 'Edit' }]} />`}
      <span class="dim small grow ellipsis">${path}</span>
      <button class="btn sm" onClick=${() => { close(); openFileInEditor(path); }}><${Icon} name="code" />Open in Code</button>
      ${mode === 'edit' && html`<button class="btn sm primary" disabled=${!dirty} onClick=${save}>Save</button>`}</div>
    ${text == null ? html`<div class="spinner"></div>` : mode === 'preview' ? html`<div class="scroll card" style="flex:1"><${Markdown} text=${text} /></div>` : html`<div class="editor-host" ref=${host} style="flex:1"></div>`}
  </div>`;
  if (!url) return html`<div class="spinner"></div>`;
  if (/^(png|jpe?g|gif|webp|svg|bmp|heic)$/.test(ext)) return html`<div class="viewer" style="height:auto"><img src=${url} alt=${path} /></div>`;
  if (/^(mp4|mov|webm|m4v)$/.test(ext)) return html`<div class="viewer" style="height:auto"><video src=${url} controls playsinline></video></div>`;
  if (/^(mp3|wav|m4a|ogg|flac|aac)$/.test(ext)) return html`<audio src=${url} controls style="width:100%"></audio>`;
  if (ext === 'pdf') return html`<div class="viewer"><object data=${url} type="application/pdf"><a href=${url} target="_blank">Open PDF</a></object></div>`;
  if (/^(docx|xlsx|pptx)$/.test(ext)) return html`<${DocText} path=${path} />`;
  return html`<div class="empty"><${Icon} name=${fileIcon(path)} /><h3>${vfs.basename(path)}</h3><div class="small">This file can't be shown here.</div><button class="btn" onClick=${() => shareFile(path)}><${Icon} name="share" />Share / save to Files</button></div>`;
}

function DocText({ path }) {
  const [t, setT] = useState(null);
  useEffect(() => { import('../../agent/tools/docs.js').then(m => m.readDocument(path)).then(setT).catch(e => setT('Could not read: ' + e.message)); }, [path]);
  return t == null ? html`<div class="spinner"></div>` : html`<div class="card scroll" style="max-height:70vh;white-space:pre-wrap;font-size:14px">${t}</div>`;
}

// ---------- search across the Hub ----------
function openSearch() {
  openSheet({ title: 'Search the Hub', wide: true }, () => html`<${Search} />`);
}
function Search() {
  const [q, setQ] = useState('');
  const [res, setRes] = useState(null);
  const run = async () => {
    if (!q.trim()) return;
    setRes('busy');
    const out = [];
    const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    for await (const e of vfs.walk('/', { ignore: new Set(['models', 'runtimes', 'node_modules', '.git', 'trash']), details: true })) {
      if (re.test(e.name)) out.push({ path: e.path, line: null, text: 'file name' });
      else if (isTextName(e.name) && (e.size || 0) < 500000) {
        const t = await vfs.readText(e.path).catch(() => '');
        const i = t.search(re);
        if (i >= 0) { const ln = t.slice(0, i).split('\n').length; out.push({ path: e.path, line: ln, text: t.split('\n')[ln - 1].trim().slice(0, 160) }); }
      }
      if (out.length > 100) break;
    }
    setRes(out);
  };
  return html`<div class="row"><input class="input" autofocus placeholder="Text or file name" value=${q} onInput=${e => setQ(e.target.value)} onKeyDown=${e => e.key === 'Enter' && run()} /><button class="btn primary" onClick=${run}>Search</button></div>
    ${res === 'busy' ? html`<div style="margin-top:14px"><${Progress} indet /></div>` : res && html`<div class="list search-results" style="margin-top:12px">${res.length ? res.map(r => html`<button class="li" onClick=${() => isTextName(r.path) ? openFileInEditor(r.path, r.line) : openViewer(r.path)}><span class="li-icon"><${Icon} name=${fileIcon(r.path)} /></span><div class="li-main"><div class="li-title">${r.path}${r.line ? ':' + r.line : ''}</div><div class="li-sub">${r.text}</div></div></button>`) : html`<div class="li dim">No matches</div>`}</div>`}`;
}

// ---------- Knowledge (RAG) ----------
function KnowledgeView({ path }) {
  const [cols, setCols] = useState(null);
  const [q, setQ] = useState('');
  const [hits, setHits] = useState(null);
  const load = async () => { const { listCollections } = await import('../../rag/rag.js'); setCols(await listCollections()); };
  useEffect(() => { load(); }, []);
  const [busy, setBusy] = useState(null);
  const index = async (name) => {
    setBusy(name);
    try { const { indexCollection } = await import('../../rag/rag.js'); const m = await indexCollection(name); toast(`Indexed ${m.files} files into ${m.chunks} passages${m.embedModel ? '' : ' (keyword search only: embeddings unavailable offline until downloaded)'}`, 'ok', 5000); }
    catch (e) { toast(String(e.message || e), 'err'); }
    setBusy(null); load();
  };
  const search = async () => { const { search } = await import('../../rag/rag.js'); setHits(await search(q, { k: 8 })); };
  return html`<${Crumbs} path=${path} />
    <div class="hub-scroll"><div class="page">
      <${Banner} icon="book">Each collection is a folder of documents (PDF, Word, Markdown, text, web pages, code). Index it, and the agent can search it with the Recall tool.<//>
      <div class="row" style="margin:12px 0"><button class="btn primary sm" onClick=${async () => { const n = await promptDialog({ title: 'New collection', placeholder: 'research' }); if (n) { await TEMPLATES['/knowledge'].make(n.trim().replace(/[^\w-]+/g, '-')); load(); } }}><${Icon} name="plus" />New collection</button></div>
      <div class="list">${(cols || []).map(c => html`<div class="li">
        <span class="li-icon"><${Icon} name="book" /></span>
        <div class="li-main" onClick=${() => hubStore.set({ path: c.path + '/docs' })} style="cursor:pointer"><div class="li-title">${c.name}</div><div class="li-sub">${c.docs} docs · ${c.chunks} passages${c.indexed ? ' · indexed ' + relTime(c.indexed) : ' · not indexed'}</div></div>
        <button class="btn sm" onClick=${() => importInto(c.path + '/docs')}><${Icon} name="upload" /></button>
        <button class="btn sm" disabled=${busy === c.name} onClick=${() => index(c.name)}>${busy === c.name ? html`<div class="spinner"></div>` : 'Index'}</button></div>`)}</div>
      <div class="section-title">Test search</div>
      <div class="row"><input class="input" placeholder="Ask your knowledge base…" value=${q} onInput=${e => setQ(e.target.value)} onKeyDown=${e => e.key === 'Enter' && search()} /><button class="btn" onClick=${search}>Search</button></div>
      ${hits && html`<div class="list" style="margin-top:10px">${hits.length ? hits.map(h => html`<div class="li" style="align-items:flex-start"><div class="li-main"><div class="li-sub">${h.source} · ${h.score.toFixed(2)}</div><div class="small" style="white-space:pre-wrap;margin-top:4px">${h.text.slice(0, 500)}</div></div></div>`) : html`<div class="li dim">Nothing found</div>`}</div>`}
    </div></div>`;
}
