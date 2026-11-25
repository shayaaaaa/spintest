// Execution tools: Bash (jsh shell / Linux VM), RunJS (sandbox), Python (Pyodide), Preview.
import { clip } from '../../core/util.js';
import { createShell, sandboxRpc } from '../../shell/host.js';
import { bus } from '../../core/bus.js';
import * as vfs from '../../core/vfs.js';

export const Bash = {
  name: 'Bash',
  description: `Run a shell command in the built-in POSIX-like shell (jsh) over the Hub. / is the Hub root; projects live in /workspace. Supports pipes, &&, ||, redirects, globs and ~60 commands (ls cat grep find sed sort head tail wc mkdir rm cp mv tree diff jq curl zip unzip git python pip node …). Prefer the Read/Edit/Glob/Grep tools for file work. "linux <cmd>" runs a command in the full Linux VM if it is installed. The working directory persists between calls.`,
  input_schema: { type: 'object', properties: { command: { type: 'string' }, description: { type: 'string', description: '5–10 word description of what it does' }, timeout: { type: 'number', description: 'Milliseconds (max 600000)' } }, required: ['command'] },
  kind: 'exec',
  key: (i) => i.command,
  summary: (i) => i.command,
  async preview(i) { return { type: 'command', command: i.command, description: i.description }; },
  async run({ command, timeout }, ctx) {
    const sh = ctx.session.shell ||= createShell({ cwd: ctx.cwd, session: ctx.session });
    if (!sh.cwd.startsWith('/')) sh.cwd = ctx.cwd;
    const ac = new AbortController();
    const onAbort = () => ac.abort(); ctx.signal?.addEventListener('abort', onAbort);
    const t = setTimeout(() => ac.abort(), Math.min(timeout || 120000, 600000));
    let live = '';
    try {
      sh.history.push(command);
      const r = await sh.run(command, { signal: ac.signal, onOutput: (s) => { live += s; ctx.onProgress?.(live.slice(-2000)); } });
      const out = (r.stdout + (r.stderr ? (r.stdout ? '\n' : '') + r.stderr : '')).replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
      if (sh.cwd !== ctx.session.cwd && sh.cwd.startsWith('/workspace/')) ctx.session.setCwd?.(sh.cwd);
      const content = clip(out || '(no output)', 30000) + (r.code ? `\n[exit code ${r.code}]` : '');
      return { content, isError: r.code !== 0 && !out, display: { kind: 'shell', output: out, code: r.code } };
    } finally { clearTimeout(t); ctx.signal?.removeEventListener('abort', onAbort); }
  },
};

export const RunJS = {
  name: 'RunJS',
  description: 'Run JavaScript in an isolated sandbox (no DOM, no app access). Top-level await works; console.log output and the returned value come back. ctx.readFile(path) / ctx.writeFile(path, text) / ctx.listDir(path) access the project folder. Good for calculations, data processing and quick tests.',
  input_schema: { type: 'object', properties: { code: { type: 'string' } }, required: ['code'] },
  kind: 'exec',
  key: () => 'js',
  summary: (i) => i.code.split('\n')[0].slice(0, 80),
  async preview(i) { return { type: 'code', lang: 'javascript', code: i.code }; },
  async run({ code }, ctx) {
    const { runSandboxed } = await import('../../runtimes/sandbox.js');
    const r = await runSandboxed(code, { mode: 'script', rpc: sandboxRpc(ctx.cwd), timeoutMs: 60000 });
    const out = [...(r.logs || []), r.result !== undefined ? '→ ' + (typeof r.result === 'string' ? r.result : JSON.stringify(r.result, null, 2)) : '', r.error ? 'Error: ' + r.error : ''].filter(Boolean).join('\n');
    return { content: clip(out || '(no output)', 20000), isError: !!r.error, display: { kind: 'shell', output: out, code: r.error ? 1 : 0, ms: r.ms } };
  },
};

export const Python = {
  name: 'Python',
  description: 'Run Python 3.13 (Pyodide) with numpy, pandas, matplotlib, scipy, scikit-learn and more, fully on-device (first use downloads ~25 MB). The project folder is the working directory; files written there are saved. plt.show() saves PNG figures.',
  input_schema: { type: 'object', properties: { code: { type: 'string' } }, required: ['code'] },
  kind: 'exec',
  key: () => 'python',
  summary: (i) => i.code.split('\n')[0].slice(0, 80),
  async preview(i) { return { type: 'code', lang: 'python', code: i.code }; },
  async run({ code }, ctx) {
    const { runPython } = await import('../../runtimes/python.js');
    let live = '';
    const r = await runPython(code, { cwd: ctx.cwd, signal: ctx.signal, onOutput: (s) => { live += s; ctx.onProgress?.(live.slice(-2000)); } });
    const out = [r.output.trimEnd(), r.result ? '→ ' + r.result : '', r.error ? r.error : '', r.changed.length ? `Files written: ${r.changed.join(', ')}` : ''].filter(Boolean).join('\n');
    const images = r.changed.filter(p => /\.png$/i.test(p));
    return { content: clip(out || '(no output)', 20000), isError: !!r.error, display: { kind: 'shell', output: out, code: r.error ? 1 : 0, images } };
  },
};

export const Preview = {
  name: 'Preview',
  description: 'Open an HTML file from the project in the live preview panel (to show the user a web page or app you built).',
  input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  readOnly: true, kind: 'other',
  summary: (i) => i.path,
  async run({ path }, ctx) {
    const p = vfs.normalize(path, ctx.cwd);
    if (!(await vfs.exists(p))) throw new Error(`${p} not found`);
    bus.emit('preview', { path: p });
    return { content: `Opened ${p} in the preview.`, display: { kind: 'text', text: 'Opened preview' } };
  },
};

export const execTools = [Bash, RunJS, Python, Preview];
