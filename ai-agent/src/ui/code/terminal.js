// Touch-friendly terminal for jsh: scrollback + an input line with history, Tab completion and a key bar.
import { html, useState, useEffect, useRef } from '../../../vendor/preact.mjs';
import { createShell } from '../../shell/host.js';
import { COMMANDS } from '../../shell/jsh.js';
import * as vfs from '../../core/vfs.js';

const shells = new Map();
export function getShell(key, cwd) {
  if (!shells.has(key)) shells.set(key, { sh: createShell({ cwd }), lines: [{ t: 'c', s: 'jsh — type help for commands, linux to open the Linux VM shell\n' }] });
  return shells.get(key);
}

export function Terminal({ id = 'main', cwd = '/workspace', onCwd }) {
  const state = getShell(id, cwd);
  const [lines, setLines] = useState(state.lines);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [, force] = useState(0);
  const out = useRef(); const inp = useRef(); const hist = useRef(-1); const ctrl = useRef(null);
  const sh = state.sh;
  useEffect(() => { if (cwd && !busy && sh.cwd !== cwd && !state.userCd) { sh.cwd = cwd; force(n => n + 1); } }, [cwd]);
  useEffect(() => { const el = out.current; if (el) el.scrollTop = el.scrollHeight; }, [lines]);
  const push = (l) => { state.lines = [...state.lines, l].slice(-2000); setLines(state.lines); };
  const prompt = () => state.linux ? 'alpine # ' : (sh.cwd === '/' ? '~' : '~' + sh.cwd) + ' $ ';
  const run = async (cmd) => {
    push({ t: 'p', s: prompt(), cmd });
    if (!cmd.trim()) return;
    if (cmd.trim() === 'clear') { state.lines = []; setLines([]); return; }
    sh.history.push(cmd); hist.current = -1;
    if (state.linux && cmd.trim() === 'exit') { state.linux = false; push({ t: 'c', s: 'Back to jsh. The VM keeps running in the background (linux --stop to stop it).\n' }); force(n => n + 1); return; }
    if (!state.linux && cmd.trim() === 'linux') {
      state.linux = true; force(n => n + 1);
      push({ t: 'c', s: 'Alpine Linux VM (type exit to return to jsh; linux --put/--get copy files from/to the Hub).\n' });
      cmd = 'uname -sr; cat /etc/alpine-release';
    }
    setBusy(true);
    ctrl.current = new AbortController();
    let buf = '';
    const flush = () => { if (buf) { push({ t: 'o', s: buf.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '') }); buf = ''; } };
    const timer = setInterval(flush, 120);
    const before = sh.cwd;
    try {
      const r = state.linux
        ? await (async () => { const { linuxRun } = await import('../../runtimes/linux.js'); const code = await linuxRun(/^\s*linux\s+(--\w+)/.test(cmd) ? cmd.replace(/^\s*linux\s+/, '') : cmd, { io: { out: (s) => { buf += s; }, err: (s) => { buf += s; } }, cwd: sh.cwd, signal: ctrl.current.signal }); return { code, stdout: buf || ' ' }; })()
        : await sh.run(cmd, { onOutput: (s) => { buf += s; }, signal: ctrl.current.signal });
      clearInterval(timer); flush();
      if (r.code && !r.stdout && !r.stderr) push({ t: 'e', s: `exit ${r.code}\n` });
    } catch (e) { clearInterval(timer); flush(); push({ t: 'e', s: String(e.message || e) + '\n' }); }
    setBusy(false);
    if (sh.cwd !== before) { state.userCd = true; onCwd?.(sh.cwd); }
    setTimeout(() => inp.current?.focus(), 30);
  };
  const complete = async () => {
    const m = /(\S*)$/.exec(input); const word = m[1];
    const first = !input.trim().includes(' ');
    let opts = [];
    if (first) opts = Object.keys(COMMANDS).filter(c => c.startsWith(word));
    else {
      const dir = word.includes('/') ? word.slice(0, word.lastIndexOf('/') + 1) : '';
      const base = word.slice(dir.length);
      try { opts = (await vfs.list(vfs.normalize(dir || '.', sh.cwd))).filter(e => e.name.startsWith(base)).map(e => dir + e.name + (e.kind === 'directory' ? '/' : '')); } catch {}
    }
    if (opts.length === 1) setInput(input.slice(0, input.length - word.length) + opts[0] + (opts[0].endsWith('/') ? '' : ' '));
    else if (opts.length > 1) { push({ t: 'c', s: opts.join('  ') + '\n' }); let p = opts[0]; for (const o of opts) while (!o.startsWith(p)) p = p.slice(0, -1); if (p.length > word.length) setInput(input.slice(0, input.length - word.length) + p); }
  };
  const onKey = (e) => {
    if (e.key === 'Enter') { const c = input; setInput(''); run(c); e.preventDefault(); }
    else if (e.key === 'Tab') { e.preventDefault(); complete(); }
    else if (e.key === 'ArrowUp') { const h = sh.history; if (hist.current + 1 < h.length) { hist.current++; setInput(h[h.length - 1 - hist.current]); } e.preventDefault(); }
    else if (e.key === 'ArrowDown') { const h = sh.history; if (hist.current > 0) { hist.current--; setInput(h[h.length - 1 - hist.current]); } else { hist.current = -1; setInput(''); } e.preventDefault(); }
    else if (e.key === 'c' && e.ctrlKey) { ctrl.current?.abort(); push({ t: 'e', s: '^C\n' }); }
    else if (e.key === 'l' && e.ctrlKey) { state.lines = []; setLines([]); e.preventDefault(); }
  };
  const key = (k) => {
    if (k === 'Tab') return complete();
    if (k === '↑') return onKey({ key: 'ArrowUp', preventDefault() {} });
    if (k === '↓') return onKey({ key: 'ArrowDown', preventDefault() {} });
    if (k === '^C') { ctrl.current?.abort(); return push({ t: 'e', s: '^C\n' }); }
    setInput(input + k); inp.current?.focus();
  };
  return html`<div style="flex:1;display:flex;flex-direction:column;min-height:0" onClick=${(e) => { if (!window.getSelection()?.toString()) inp.current?.focus(); }}>
    <div class="jterm" ref=${out}>${lines.map(l => l.t === 'p' ? html`<div><span class="p">${l.s}</span>${l.cmd}</div>` : html`<span class=${l.t === 'e' ? 'e' : l.t === 'c' ? 'c' : ''}>${l.s}</span>`)}</div>
    <div class="jterm-input"><span class="p" style="color:var(--ok);white-space:nowrap">${busy ? '…' : prompt()}</span>
      <input ref=${inp} value=${input} onInput=${e => setInput(e.target.value)} onKeyDown=${onKey} autocapitalize="off" autocorrect="off" autocomplete="off" spellcheck="false" enterkeyhint="go" aria-label="Command" /></div>
    <div class="jterm-keys">${['Tab', '↑', '↓', '^C', '|', '>', '/', '-', '~', '&&', '*', '"'].map(k => html`<button onPointerDown=${(e) => { e.preventDefault(); key(k); }}>${k}</button>`)}</div>
  </div>`;
}
