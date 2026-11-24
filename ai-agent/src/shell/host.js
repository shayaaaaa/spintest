// Creates jsh shells wired to the app's runtimes (Python, JS sandbox, Linux VM, git, editor/preview).
import { Shell } from './jsh.js';
import * as vfs from '../core/vfs.js';
import { bus } from '../core/bus.js';

export function sandboxRpc(cwd, { allowWrite = true, allowNet = true } = {}) {
  return async (method, args) => {
    const inside = (p) => { const a = vfs.normalize(p, cwd); if (!a.startsWith('/workspace') && !a.startsWith(cwd)) throw new Error('Access outside the project is not allowed'); return a; };
    if (method === 'readFile') return vfs.readText(inside(args[0]));
    if (method === 'writeFile') { if (!allowWrite) throw new Error('Writing is not allowed here'); await vfs.write(inside(args[0]), String(args[1])); return true; }
    if (method === 'listDir') return (await vfs.list(inside(args[0] || '.'))).map(e => e.name + (e.kind === 'directory' ? '/' : ''));
    if (method === 'fetch') { if (!allowNet || !navigator.onLine) throw new Error('Network not available'); const r = await fetch(args[0], args[1] || {}); return { status: r.status, text: await r.text() }; }
    throw new Error('Unknown method ' + method);
  };
}

export function createShell({ cwd = '/workspace', session } = {}) {
  const sh = new Shell({ cwd });
  sh.hooks = {
    async python(code, io, shell, ctx) {
      const { runPython } = await import('../runtimes/python.js');
      const r = await runPython(code, { cwd: shell.cwd, onOutput: (s) => io.out(s), signal: ctx.signal, file: ctx.file, argv: ctx.argv });
      if (r.error) { io.err(r.error + '\n'); return 1; }
      return 0;
    },
    async pip(args, io) {
      const { ensurePackages, install, isInstalled } = await import('../runtimes/python.js');
      const names = args.filter(a => !a.startsWith('-') && a !== 'install');
      if (args[0] !== 'install' || !names.length) { io.err('usage: pip install <package> (packages from the Pyodide distribution)\n'); return 2; }
      if (!(await isInstalled())) await install();
      const got = await ensurePackages(names);
      io.out(got.length ? `Ready: ${got.join(', ')}\n` : `No Pyodide build found for: ${names.join(', ')}. Pure-Python packages can be installed in code with: import micropip; await micropip.install("name")\n`);
      return got.length ? 0 : 1;
    },
    async js(code, io, shell, ctx) {
      const { runSandboxed } = await import('../runtimes/sandbox.js');
      const r = await runSandboxed(code, { mode: 'script', rpc: sandboxRpc(shell.cwd), timeoutMs: 60000 });
      for (const l of r.logs || []) io.out(l + '\n');
      if (r.result !== undefined) io.out((typeof r.result === 'string' ? r.result : JSON.stringify(r.result, null, 2)) + '\n');
      if (r.error) { io.err(r.error + '\n'); return 1; }
      return 0;
    },
    async linux(argv, io, shell, ctx) {
      const { linuxRun } = await import('../runtimes/linux.js');
      return linuxRun(argv.join(' '), { io, cwd: shell.cwd, signal: ctx.signal });
    },
    linuxEnabled: () => !!globalThis.__aiaLinuxReady,
    async git(args, io, shell, ctx) {
      const { gitCommand } = await import('../runtimes/git.js');
      return gitCommand(args, io, shell, ctx);
    },
    open(path) { bus.emit('open-file', { path }); },
    preview(path) { bus.emit('preview', { path }); },
  };
  return sh;
}
