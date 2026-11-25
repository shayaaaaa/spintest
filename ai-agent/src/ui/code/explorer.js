// File tree for the Code tab (and Hub): expand/collapse, open, create, rename, delete (to trash), long-press menu.
import { html, useState, useEffect } from '../../../vendor/preact.mjs';
import { Icon, fileIcon } from '../icons.js';
import { openMenu, promptDialog, confirmDialog, toast, useLongPress } from '../kit.js';
import * as vfs from '../../core/vfs.js';

export function useDirListing(path, deps = []) {
  const [items, setItems] = useState(null);
  useEffect(() => {
    let alive = true;
    const load = () => vfs.list(path).then(l => alive && setItems(l)).catch(() => alive && setItems([]));
    load();
    const off = vfs.events.on('change', (e) => { if (vfs.dirname(e.path) === path || e.path === path) load(); });
    return () => { alive = false; off(); };
  }, [path, ...deps]);
  return items;
}

export async function fileActions(e, entry, { onOpen, onRenamed } = {}) {
  const isDir = entry.kind === 'directory';
  openMenu(e, [
    !isDir && { icon: 'edit', text: 'Open', onClick: () => onOpen?.(entry.path) },
    isDir && { icon: 'file', text: 'New file…', onClick: () => newEntry(entry.path, 'file', onOpen) },
    isDir && { icon: 'folder', text: 'New folder…', onClick: () => newEntry(entry.path, 'directory') },
    { icon: 'type', text: 'Rename…', onClick: async () => { const n = await promptDialog({ title: 'Rename', value: entry.name }); if (n && n !== entry.name) { const to = vfs.join(vfs.dirname(entry.path), n); await vfs.move(entry.path, to); onRenamed?.(entry.path, to); } } },
    { icon: 'copy', text: 'Duplicate', onClick: async () => { const ext = entry.name.includes('.') && !isDir ? '.' + entry.name.split('.').pop() : ''; await vfs.copy(entry.path, vfs.join(vfs.dirname(entry.path), entry.name.replace(new RegExp(ext.replace('.', '\\.') + '$'), '') + ' copy' + ext)); } },
    { icon: 'link', text: 'Copy path', onClick: () => navigator.clipboard?.writeText(entry.path).then(() => toast('Path copied', 'ok')) },
    !isDir && { icon: 'share', text: 'Share / save to Files', onClick: () => shareFile(entry.path) },
    '-',
    { icon: 'trash', text: 'Move to trash', danger: true, onClick: async () => { if (await confirmDialog({ title: `Delete ${entry.name}?`, message: 'It goes to the Hub trash folder.', ok: 'Delete', danger: true })) { await vfs.move(entry.path, `/trash/${Date.now()}-${entry.name}`); toast('Moved to trash'); } } },
  ]);
}

export async function shareFile(path) {
  const f = await vfs.getFile(path);
  const file = new File([f], vfs.basename(path), { type: f.type || 'application/octet-stream' });
  try { if (navigator.canShare?.({ files: [file] })) return await navigator.share({ files: [file], title: file.name }); } catch (e) { if (e.name === 'AbortError') return; }
  const a = document.createElement('a'); a.href = URL.createObjectURL(file); a.download = file.name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 3000);
}

export async function newEntry(dir, kind, onOpen) {
  const name = await promptDialog({ title: kind === 'file' ? 'New file' : 'New folder', placeholder: kind === 'file' ? 'index.html' : 'src' });
  if (!name) return;
  const p = vfs.join(dir, name.trim());
  if (await vfs.exists(p)) return toast('Already exists', 'warn');
  if (kind === 'file') { await vfs.write(p, ''); onOpen?.(p); } else await vfs.mkdir(p);
}

function Node({ entry, depth, open, toggle, selected, onOpen, changed }) {
  const isDir = entry.kind === 'directory';
  const lp = useLongPress((ev) => fileActions(ev, entry, { onOpen }));
  return html`<button class=${'tnode' + (selected === entry.path ? ' on' : '')} style=${`padding-left:${8 + depth * 14}px`} ...${lp}
    onClick=${() => isDir ? toggle(entry.path) : onOpen(entry.path)}>
    ${isDir ? html`<svg class=${'chev' + (open ? ' open' : '')} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M9 6l6 6-6 6"/></svg>` : html`<span style="width:12px"></span>`}
    <${Icon} name=${isDir ? (open ? 'folderOpen' : 'folder') : fileIcon(entry.name)} />
    <span class="name">${entry.name}</span>${changed && html`<span class="changed">M</span>`}
  </button>`;
}

function Dir({ path, depth, openSet, toggle, selected, onOpen, changedSet, showHidden }) {
  const items = useDirListing(path);
  if (!items) return null;
  return html`${items.filter(e => showHidden || !e.name.startsWith('.') || e.name === '.hub').filter(e => !vfs.DEFAULT_IGNORE.has(e.name) || showHidden).map(e => html`
    <${Node} key=${e.path} entry=${e} depth=${depth} open=${openSet.has(e.path)} toggle=${toggle} selected=${selected} onOpen=${onOpen} changed=${changedSet?.has(e.path)} />
    ${e.kind === 'directory' && openSet.has(e.path) && html`<${Dir} path=${e.path} depth=${depth + 1} openSet=${openSet} toggle=${toggle} selected=${selected} onOpen=${onOpen} changedSet=${changedSet} showHidden=${showHidden} />`}`)}`;
}

export function FileTree({ root, selected, onOpen, changedSet, showHidden = false }) {
  const [openSet, setOpen] = useState(() => new Set());
  const toggle = (p) => setOpen(s => { const n = new Set(s); n.has(p) ? n.delete(p) : n.add(p); return n; });
  return html`<div class="tree"><${Dir} path=${root} depth=${0} openSet=${openSet} toggle=${toggle} selected=${selected} onOpen=${onOpen} changedSet=${changedSet} showHidden=${showHidden} /></div>`;
}
