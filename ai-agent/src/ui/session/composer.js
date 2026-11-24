// Message composer with slash-command and @file suggestions, attachments, dictation, history, send/stop.
import { html, useState, useEffect, useRef } from '../../../vendor/preact.mjs';
import { useStore } from '../../core/store.js';
import { Icon } from '../icons.js';
import { toast } from '../kit.js';
import { env } from '../../core/platform.js';
import * as vfs from '../../core/vfs.js';
import { allCommands } from '../../agent/commands.js';
import { fileToImageBlock } from '../../models/content.js';
import { extOf, isTextName } from '../../core/util.js';

const history = { agent: [], chat: [], code: [] };

export async function filesToAttachments(files) {
  const out = [];
  for (const f of files) {
    try {
      if (f.type.startsWith('image/')) { const b = await fileToImageBlock(f); out.push({ ...b, _name: f.name }); }
      else if (/pdf|word|sheet|presentation/.test(f.type) || /\.(pdf|docx|xlsx|pptx)$/i.test(f.name)) {
        const tmp = `/inbox/${Date.now()}-${f.name}`;
        await vfs.write(tmp, f);
        const { readDocument } = await import('../../agent/tools/docs.js');
        const text = await readDocument(tmp);
        out.push({ type: 'text', text: `<file path="${tmp}">\n${text.slice(0, 150000)}\n</file>`, _name: f.name });
      } else if (isTextName(f.name) || f.type.startsWith('text/')) {
        out.push({ type: 'text', text: `<file path="${f.name}">\n${(await f.text()).slice(0, 150000)}\n</file>`, _name: f.name });
      } else {
        const tmp = `/inbox/${f.name}`;
        await vfs.write(tmp, f);
        out.push({ type: 'text', text: `[The user attached a file, saved at ${tmp} (${extOf(f.name) || 'binary'}, ${f.size} bytes)]`, _name: f.name });
      }
    } catch (e) { toast(`Couldn't attach ${f.name}: ${e.message}`, 'err'); }
  }
  return out;
}

export function Composer({ session, kind = 'agent', placeholder = 'Ask anything, or type / for commands', onSubmit, statusLine, extraLeft, autoFocus = false }) {
  const st = useStore(session.store, s => ({ status: s.status, queued: s.queued, cwd: s.cwd }));
  const touch = useStore(env, s => s.touch);
  const [text, setText] = useState('');
  const [atts, setAtts] = useState([]);
  const [sugg, setSugg] = useState(null); // {items, sel, kind}
  const [listening, setListening] = useState(false);
  const ta = useRef(); const fileIn = useRef(); const hIdx = useRef(-1);
  const busy = st.status !== 'idle';

  useEffect(() => { if (autoFocus && !touch) ta.current?.focus(); }, []);
  useEffect(() => { const el = ta.current; if (!el) return; el.style.height = 'auto'; el.style.height = Math.min(el.scrollHeight, window.innerHeight * 0.4) + 'px'; }, [text]);

  // suggestions
  useEffect(() => {
    let cancel = false;
    (async () => {
      if (/^\/\S*$/.test(text)) {
        const q = text.slice(1).toLowerCase();
        const cmds = (await allCommands(st.cwd)).filter(c => c.name.toLowerCase().startsWith(q) || (q.length > 1 && c.name.toLowerCase().includes(q)));
        if (!cancel) setSugg(cmds.length ? { kind: 'cmd', items: cmds.slice(0, 30), sel: 0 } : null);
        return;
      }
      const m = /(^|\s)@([^\s]*)$/.exec(text);
      if (m) {
        const q = m[2].toLowerCase();
        const items = [];
        for await (const e of vfs.walk(st.cwd, { includeDirs: true, maxDepth: 4 })) {
          const rel = vfs.relative(st.cwd, e.path) + (e.kind === 'directory' ? '/' : '');
          if (!q || rel.toLowerCase().includes(q)) items.push({ name: rel, desc: e.kind === 'directory' ? 'folder' : '' });
          if (items.length > 40) break;
        }
        if (!cancel) setSugg(items.length ? { kind: 'file', items: items.sort((a, b) => a.name.length - b.name.length).slice(0, 20), sel: 0 } : null);
        return;
      }
      setSugg(null);
    })();
    return () => { cancel = true; };
  }, [text, st.cwd]);

  const applySugg = (it) => {
    if (sugg.kind === 'cmd') setText('/' + it.name + ' ');
    else setText(text.replace(/@([^\s]*)$/, '@' + it.name + (it.name.endsWith('/') ? '' : ' ')));
    setSugg(null);
    ta.current?.focus();
  };

  const submit = async () => {
    const t = text.trim();
    if (!t && !atts.length) return;
    history[kind].unshift(t); hIdx.current = -1;
    setText(''); const a = atts; setAtts([]); setSugg(null);
    await onSubmit(t, a.map(({ _name, _w, _h, ...b }) => b));
  };

  const onKey = (e) => {
    if (sugg) {
      if (e.key === 'ArrowDown') { setSugg({ ...sugg, sel: (sugg.sel + 1) % sugg.items.length }); e.preventDefault(); return; }
      if (e.key === 'ArrowUp') { setSugg({ ...sugg, sel: (sugg.sel - 1 + sugg.items.length) % sugg.items.length }); e.preventDefault(); return; }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey && sugg.kind === 'file')) { applySugg(sugg.items[sugg.sel]); e.preventDefault(); return; }
      if (e.key === 'Enter' && !e.shiftKey && sugg.kind === 'cmd' && !text.includes(' ')) { const it = sugg.items[sugg.sel]; setSugg(null); setText(''); history[kind].unshift('/' + it.name); onSubmit('/' + it.name, []); e.preventDefault(); return; }
      if (e.key === 'Escape') { setSugg(null); e.preventDefault(); return; }
    }
    if (e.key === 'Enter' && !e.shiftKey && !touch) { e.preventDefault(); submit(); return; }
    if (e.key === 'Escape' && busy) { session.stop(); e.preventDefault(); return; }
    if (e.key === 'Tab' && e.shiftKey && kind !== 'chat') { e.preventDefault(); import('../../agent/permissions.js').then(({ nextMode }) => session.setMode(nextMode(session.mode))); return; }
    if (e.key === 'ArrowUp' && !text.includes('\n') && (ta.current.selectionStart === 0 || !text)) { const h = history[kind]; if (hIdx.current + 1 < h.length) { hIdx.current++; setText(h[hIdx.current]); e.preventDefault(); } }
    if (e.key === 'ArrowDown' && hIdx.current >= 0 && !text.includes('\n')) { hIdx.current--; setText(hIdx.current >= 0 ? history[kind][hIdx.current] : ''); e.preventDefault(); }
  };

  const onPaste = async (e) => {
    const files = [...(e.clipboardData?.files || [])];
    if (files.length) { e.preventDefault(); setAtts([...atts, ...await filesToAttachments(files)]); }
  };

  const dictate = async () => {
    if (listening) return;
    setListening(true);
    try {
      const { listen } = await import('../../models/speech.js');
      const base = text;
      const t = await listen({ onPartial: (p) => setText((base ? base + ' ' : '') + p) });
      setText((base ? base + ' ' : '') + (t || ''));
    } catch (e) { toast(String(e.message || e), 'err'); }
    finally { setListening(false); }
  };

  const mode = text.startsWith('!') ? 'bash' : text.startsWith('#') ? 'memo' : '';
  const prefix = mode === 'bash' ? '!' : mode === 'memo' ? '#' : '›';
  return html`<div class=${'composer-wrap' + (kind !== 'chat' ? ' term-mode' : '')}>
    ${sugg && html`<div class="suggest" role="listbox">${sugg.items.map((it, i) => html`<button class=${'suggest-item' + (i === sugg.sel ? ' sel' : '')} onPointerDown=${(e) => { e.preventDefault(); applySugg(it); }}>
      <span>${sugg.kind === 'cmd' ? '/' : '@'}${it.name}${it.args ? html` <span class="dim">${it.args}</span>` : ''}</span><span class="d">${it.desc}</span>${it.custom && html`<span class="tag">${it.scope}</span>`}</button>`)}</div>`}
    ${st.queued.length > 0 && html`<div class="queued">${st.queued.map(q => html`<div>⏳ queued: ${q.slice(0, 80)}</div>`)}</div>`}
    ${atts.length > 0 && html`<div class="attach-row">${atts.map((a, i) => html`<span class="attach-chip">${a.type === 'image' ? html`<img src=${`data:${a.source.media_type};base64,${a.source.data}`} alt="" />` : html`<${Icon} name="file" size=${14} />`}<span class="ellipsis">${a._name || 'attachment'}</span><button class="ibtn" onClick=${() => setAtts(atts.filter((_, j) => j !== i))} aria-label="Remove"><${Icon} name="x" size=${12} /></button></span>`)}</div>`}
    <div class=${'composer ' + mode}>
      ${kind !== 'chat' && html`<span class="prefix">${prefix}</span>`}
      ${extraLeft}
      <textarea ref=${ta} rows="1" value=${text} placeholder=${busy ? 'Type to queue a message…' : placeholder} onInput=${e => setText(e.target.value)} onKeyDown=${onKey} onPaste=${onPaste}
        autocapitalize="sentences" autocomplete="off" spellcheck=${kind === 'chat'} enterkeyhint=${touch ? 'enter' : 'send'} aria-label="Message"></textarea>
      <input type="file" ref=${fileIn} multiple hidden onChange=${async e => { setAtts([...atts, ...await filesToAttachments([...e.target.files])]); e.target.value = ''; }} />
      <button class="ibtn" onClick=${() => fileIn.current.click()} aria-label="Attach files"><${Icon} name="paperclip" /></button>
      ${!text.trim() && !busy && html`<button class=${'ibtn' + (listening ? ' active' : '')} onClick=${dictate} aria-label="Dictate"><${Icon} name="mic" /></button>`}
      ${busy && !text.trim() ? html`<button class="ibtn round solid" onClick=${() => session.stop()} aria-label="Stop"><${Icon} name="stop" /></button>`
        : html`<button class="ibtn round solid" disabled=${!text.trim() && !atts.length} onClick=${submit} aria-label="Send"><${Icon} name="send" /></button>`}
    </div>
    ${statusLine}
  </div>`;
}
