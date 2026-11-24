// jsh: a small POSIX-like shell over the Hub file system. Backs the agent's Bash tool and the terminal.
// Supports pipes, && || ;, redirection (> >> < 2>&1), quotes, $VAR, $(cmd), globs, ~ and ~60 commands.
import * as vfs from '../core/vfs.js';
import { globToRegExp, unifiedDiff, extOf, isTextName } from '../core/util.js';

const enc = new TextEncoder();

// ---------- tokenizer ----------
function tokenize(src) {
  const toks = [];
  let i = 0, cur = null, quoted = false;
  const push = () => { if (cur !== null) { toks.push({ t: 'w', v: cur, q: quoted }); cur = null; quoted = false; } };
  while (i < src.length) {
    const c = src[i];
    if (c === '\\' && i + 1 < src.length) { cur = (cur ?? '') + src[i + 1]; i += 2; quoted = true; continue; }
    if (c === "'") { const j = src.indexOf("'", i + 1); if (j < 0) throw new Error('unterminated quote'); cur = (cur ?? '') + src.slice(i + 1, j); quoted = true; i = j + 1; continue; }
    if (c === '"') {
      let j = i + 1, s = '';
      while (j < src.length && src[j] !== '"') { if (src[j] === '\\' && '"\\$`'.includes(src[j + 1])) { s += src[j + 1]; j += 2; } else s += src[j++]; }
      if (j >= src.length) throw new Error('unterminated quote');
      cur = (cur ?? '') + '\u0000DQ' + s + '\u0000'; quoted = true; i = j + 1; continue;
    }
    if (c === '$' && src[i + 1] === '(') {
      let depth = 1, j = i + 2;
      while (j < src.length && depth) { if (src[j] === '(') depth++; else if (src[j] === ')') depth--; j++; }
      cur = (cur ?? '') + '\u0000SUB' + src.slice(i + 2, j - 1) + '\u0000'; i = j; continue;
    }
    if (c === '#' && cur === null) { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (/\s/.test(c)) { push(); if (c === '\n') toks.push({ t: 'op', v: ';' }); i++; continue; }
    const two = src.slice(i, i + 2), four = src.slice(i, i + 4);
    if (four === '2>&1') { push(); toks.push({ t: 'op', v: '2>&1' }); i += 4; continue; }
    if (['&&', '||', '>>', '2>'].includes(two)) { push(); toks.push({ t: 'op', v: two }); i += 2; continue; }
    if ('|;<>&'.includes(c)) { push(); toks.push({ t: 'op', v: c }); i++; continue; }
    cur = (cur ?? '') + c; i++;
  }
  push();
  return toks;
}

// ---------- parser: list of {pipeline, op} ----------
function parse(toks) {
  const list = [];
  let pipeline = [], cmd = { argv: [], redirs: [] };
  const endCmd = () => { if (cmd.argv.length || cmd.redirs.length) pipeline.push(cmd); cmd = { argv: [], redirs: [] }; };
  for (let i = 0; i < toks.length; i++) {
    const tk = toks[i];
    if (tk.t === 'w') { cmd.argv.push(tk); continue; }
    if (tk.v === '|') { endCmd(); continue; }
    if (['>', '>>', '<', '2>'].includes(tk.v)) { const f = toks[++i]; if (!f || f.t !== 'w') throw new Error('syntax error near ' + tk.v); cmd.redirs.push({ op: tk.v, file: f }); continue; }
    if (tk.v === '2>&1') { cmd.redirs.push({ op: '2>&1' }); continue; }
    if (tk.v === '&') { endCmd(); if (pipeline.length) list.push({ pipeline, op: ';', bg: true }); pipeline = []; continue; }
    endCmd();
    if (pipeline.length) list.push({ pipeline, op: tk.v });
    pipeline = [];
  }
  endCmd();
  if (pipeline.length) list.push({ pipeline, op: ';' });
  return list;
}

export class Shell {
  constructor({ cwd = '/workspace', env = {}, hooks = {} } = {}) {
    this.cwd = vfs.normalize(cwd);
    this.env = { HOME: '/', USER: 'mobile', SHELL: '/bin/jsh', PATH: '/bin', TERM: 'xterm-256color', LANG: 'en_US.UTF-8', ...env };
    this.hooks = hooks; // {python(code, ctx), js(code, ctx), linux(cmd, ctx), open(path), git(argv, ctx)}
    this.history = [];
    this.lastCode = 0;
  }

  async expandWord(tok, ctx) {
    let s = tok.v;
    // command substitution
    const subs = [];
    s = s.replace(/\u0000SUB([\s\S]*?)\u0000/g, (_, c) => { subs.push(c); return `\u0000S${subs.length - 1}\u0000`; });
    for (let k = 0; k < subs.length; k++) {
      const r = await this.run(subs[k], { ...ctx, capture: true });
      s = s.replace(`\u0000S${k}\u0000`, r.stdout.replace(/\n+$/, ''));
    }
    const hadDQ = s.includes('\u0000DQ');
    const expandVars = (x) => x.replace(/\$(\?|[A-Za-z_][A-Za-z0-9_]*|\{[A-Za-z_][A-Za-z0-9_]*\})/g, (_, n) => n === '?' ? String(this.lastCode) : (this.env[n.replace(/[{}]/g, '')] ?? ''));
    s = s.replace(/\u0000DQ([\s\S]*?)\u0000/g, (_, x) => '\u0001' + expandVars(x) + '\u0001');
    if (!tok.q || hadDQ) s = s.split('\u0001').map((part, idx) => idx % 2 ? part : expandVars(part)).join('\u0001');
    s = s.replace(/\u0001/g, '');
    if (!tok.q && (s === '~' || s.startsWith('~/'))) s = '/' + s.slice(2);
    // globbing
    if (!tok.q && /[*?[]/.test(s)) {
      const res = await vfs.glob(s, this.cwd).catch(() => []);
      if (res.length) return res.map(p => s.startsWith('/') ? p : vfs.relative(this.cwd, p)).sort();
    }
    return [s];
  }

  async run(src, ctx = {}) {
    const out = { stdout: '', stderr: '', code: 0 };
    const write = ctx.onOutput || null;
    let list;
    try { list = parse(tokenize(src)); } catch (e) { return { stdout: '', stderr: 'jsh: ' + e.message + '\n', code: 2 }; }
    let prevCode = 0, skip = false;
    for (let li = 0; li < list.length; li++) {
      const { pipeline, op } = list[li];
      if (!skip) {
        let input = ctx.stdin ?? '';
        let code = 0;
        for (let pi = 0; pi < pipeline.length; pi++) {
          if (ctx.signal?.aborted) return { ...out, stderr: out.stderr + '^C\n', code: 130 };
          const c = pipeline[pi];
          const argv = [];
          for (const w of c.argv) argv.push(...await this.expandWord(w, ctx));
          // VAR=value assignments
          while (argv.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[0])) { const [k, ...v] = argv.shift().split('='); this.env[k] = v.join('='); }
          if (!argv.length) continue;
          let stdinData = input;
          let outFile = null, append = false, errFile = null, errToOut = false;
          for (const r of c.redirs) {
            const f = r.file ? (await this.expandWord(r.file, ctx))[0] : null;
            if (r.op === '<') stdinData = await vfs.readText(vfs.normalize(f, this.cwd)).catch(() => { throw new Error(`${f}: No such file`); });
            else if (r.op === '>' || r.op === '>>') { outFile = f; append = r.op === '>>'; }
            else if (r.op === '2>') errFile = f;
            else if (r.op === '2>&1') errToOut = true;
          }
          const isLast = pi === pipeline.length - 1;
          const res = { stdout: '', stderr: '' };
          const io = {
            stdin: stdinData,
            out: (s) => { res.stdout += s; if (isLast && !outFile && write && !ctx.capture) write(s); },
            err: (s) => { if (errToOut) io.out(s); else { res.stderr += s; if (!errFile && write && !ctx.capture) write(s); } },
          };
          try { code = await this.exec(argv, io, ctx); }
          catch (e) { io.err(`${argv[0]}: ${e.message || e}\n`); code = 1; }
          if (outFile && outFile !== '/dev/null') { const p = vfs.normalize(outFile, this.cwd); append ? await vfs.append(p, res.stdout) : await vfs.write(p, res.stdout); res.stdout = ''; }
          else if (outFile === '/dev/null') res.stdout = '';
          if (errFile && errFile !== '/dev/null') await vfs.write(vfs.normalize(errFile, this.cwd), res.stderr);
          if (errFile) res.stderr = '';
          out.stderr += res.stderr;
          input = res.stdout;
          if (isLast) out.stdout += res.stdout;
        }
        prevCode = code;
        this.lastCode = code;
      }
      if (op === '&&') skip = prevCode !== 0 ? true : false;
      else if (op === '||') skip = prevCode === 0;
      else skip = false;
    }
    out.code = prevCode;
    return out;
  }

  path(p) { return vfs.normalize(p ?? '.', this.cwd); }

  async exec(argv, io, ctx) {
    const [cmd, ...args] = argv;
    const fn = COMMANDS[cmd];
    if (fn) return (await fn.call(this, args, io, ctx)) ?? 0;
    // Run a script file: ./script.sh or python file
    if (cmd.endsWith('.sh') || cmd.startsWith('./')) {
      const p = this.path(cmd);
      const src = await vfs.readText(p);
      if (/\.py$/.test(p)) return COMMANDS.python.call(this, [p, ...args], io, ctx);
      if (/\.m?js$/.test(p)) return COMMANDS.node.call(this, [p, ...args], io, ctx);
      const r = await this.run(src.replace(/^#!.*\n/, ''), { ...ctx, onOutput: null, capture: true });
      io.out(r.stdout); io.err(r.stderr); return r.code;
    }
    if (this.hooks.linux && this.hooks.linuxEnabled?.()) return this.hooks.linux(argv, io, this, ctx);
    io.err(`jsh: command not found: ${cmd}. Type 'help' for commands${this.hooks.linux ? ", or 'linux <command>' to run it in the Linux VM" : ''}.\n`);
    return 127;
  }
}

// ---------- flag parsing ----------
function flags(args, spec = '') {
  const f = {}, rest = [];
  const withVal = new Set(spec.split(',').filter(Boolean));
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') { rest.push(...args.slice(i + 1)); break; }
    if (a.startsWith('--') && a.length > 2) { const [k, v] = a.slice(2).split('='); f[k] = v ?? (withVal.has(k) ? args[++i] : true); continue; }
    if (a.startsWith('-') && a.length > 1 && !/^-\d/.test(a)) {
      for (let j = 1; j < a.length; j++) {
        const k = a[j];
        if (withVal.has(k)) { f[k] = a.slice(j + 1) || args[++i]; break; }
        f[k] = true;
      }
      continue;
    }
    if (/^-\d+$/.test(a)) { f.n = a.slice(1); continue; }
    rest.push(a);
  }
  return { f, rest };
}

async function readInputs(sh, files, io) {
  if (!files.length || (files.length === 1 && files[0] === '-')) return [{ name: '-', text: io.stdin }];
  const out = [];
  for (const f of files) { try { out.push({ name: f, text: await vfs.readText(sh.path(f)) }); } catch { io.err(`${f}: No such file or directory\n`); } }
  return out;
}

const fmtSize = (n, h) => !h ? String(n) : n < 1024 ? n + 'B' : n < 1048576 ? (n / 1024).toFixed(1) + 'K' : n < 1073741824 ? (n / 1048576).toFixed(1) + 'M' : (n / 1073741824).toFixed(1) + 'G';

export const COMMANDS = {
  help(args, io) {
    io.out(`jsh commands (a POSIX-like shell over your Hub; / is the Hub root):
  files     ls cd pwd cat head tail less wc mkdir rmdir rm cp mv touch tree find du df stat file ln
  text      echo printf grep sed sort uniq cut tr rev nl tee diff jq base64 sha256sum xargs
  run       python node js sh linux open preview
  net       curl wget        archive  zip unzip
  git       git init|status|add|commit|log|diff|branch|checkout|reset|clone
  misc      env export unset which date sleep clear history true false yes seq basename dirname realpath
Supports | && || ; > >> < 2>&1 $VAR $(cmd) globs and ~.\n`);
  },
  true() { return 0; }, false() { return 1; },
  pwd(a, io) { io.out(this.cwd + '\n'); },
  async cd(args, io) {
    const p = this.path(args[0] ?? '/workspace');
    if (!(await vfs.isDir(p))) { io.err(`cd: ${args[0]}: No such directory\n`); return 1; }
    this.cwd = p; this.env.PWD = p;
  },
  echo(args, io) { const { f, rest } = flags(args); let s = rest.join(' '); if (f.e) s = s.replace(/\\n/g, '\n').replace(/\\t/g, '\t'); io.out(s + (f.n ? '' : '\n')); },
  printf(args, io) { let [fmt = '', ...vals] = args; let i = 0; io.out(fmt.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/%[sdif]/g, () => vals[i++] ?? '')); },
  async ls(args, io) {
    const { f, rest } = flags(args);
    const targets = rest.length ? rest : ['.'];
    for (const t of targets) {
      const p = this.path(t);
      let st; try { st = await vfs.stat(p); } catch { io.err(`ls: ${t}: No such file or directory\n`); continue; }
      let items = st.kind === 'file' ? [{ ...st, name: t }] : await vfs.list(p);
      if (!f.a && !f.A) items = items.filter(e => !e.name.startsWith('.'));
      if (f.t) items.sort((a, b) => (b.mtime || 0) - (a.mtime || 0));
      if (f.S) items.sort((a, b) => (b.size || 0) - (a.size || 0));
      if (targets.length > 1) io.out(`${t}:\n`);
      if (f.l) for (const e of items) io.out(`${e.kind === 'directory' ? 'd' : '-'}rw-r--r--  ${fmtSize(e.size || 0, f.h).padStart(8)}  ${e.mtime ? new Date(e.mtime).toISOString().slice(0, 16).replace('T', ' ') : '                '}  ${e.name}${e.kind === 'directory' ? '/' : ''}\n`);
      else io.out(items.map(e => e.name + (e.kind === 'directory' ? '/' : '')).join(f[1] ? '\n' : '  ') + (items.length ? '\n' : ''));
    }
  },
  async cat(args, io) { const { f, rest } = flags(args); for (const x of await readInputs(this, rest, io)) io.out(f.n ? x.text.split('\n').map((l, i) => `${String(i + 1).padStart(6)}\t${l}`).join('\n') : x.text); },
  async less(args, io) { return COMMANDS.cat.call(this, args, io); },
  async head(args, io) { const { f, rest } = flags(args, 'n,c'); const n = Number(f.n ?? 10); for (const x of await readInputs(this, rest, io)) io.out(f.c ? x.text.slice(0, Number(f.c)) : x.text.split('\n').slice(0, n).join('\n') + '\n'); },
  async tail(args, io) { const { f, rest } = flags(args, 'n'); const n = Number(f.n ?? 10); for (const x of await readInputs(this, rest, io)) { const l = x.text.replace(/\n$/, '').split('\n'); io.out((String(f.n).startsWith('+') ? l.slice(Number(f.n) - 1) : l.slice(-n)).join('\n') + '\n'); } },
  async wc(args, io) {
    const { f, rest } = flags(args);
    const all = !f.l && !f.w && !f.c && !f.m;
    for (const x of await readInputs(this, rest, io)) {
      const parts = [];
      if (all || f.l) parts.push((x.text.match(/\n/g) || []).length);
      if (all || f.w) parts.push(x.text.split(/\s+/).filter(Boolean).length);
      if (all || f.c || f.m) parts.push(f.m ? x.text.length : enc.encode(x.text).length);
      io.out(parts.map(n => String(n).padStart(7)).join(' ') + (x.name !== '-' ? ' ' + x.name : '') + '\n');
    }
  },
  async mkdir(args, io) { const { rest } = flags(args); for (const d of rest) await vfs.mkdir(this.path(d)); },
  async rmdir(args, io) { for (const d of args) { const p = this.path(d); if ((await vfs.list(p)).length) { io.err(`rmdir: ${d}: Directory not empty\n`); return 1; } await vfs.rm(p); } },
  async rm(args, io) {
    const { f, rest } = flags(args);
    for (const x of rest) {
      const p = this.path(x);
      if (p === '/' || p === '/workspace' || /^\/(models|memory|skills|settings)$/.test(p)) { io.err(`rm: refusing to remove ${p}\n`); return 1; }
      const st = await vfs.stat(p).catch(() => null);
      if (!st) { if (!f.f) { io.err(`rm: ${x}: No such file or directory\n`); return 1; } continue; }
      if (st.kind === 'directory' && !f.r && !f.R) { io.err(`rm: ${x}: is a directory (use -r)\n`); return 1; }
      await vfs.rm(p);
    }
  },
  async cp(args, io) {
    const { f, rest } = flags(args);
    if (rest.length < 2) { io.err('usage: cp [-r] src... dest\n'); return 1; }
    const dest = this.path(rest.pop());
    const destDir = await vfs.isDir(dest);
    for (const s of rest) {
      const sp = this.path(s);
      if ((await vfs.isDir(sp)) && !f.r && !f.R) { io.err(`cp: ${s} is a directory (use -r)\n`); return 1; }
      await vfs.copy(sp, destDir ? vfs.join(dest, vfs.basename(sp)) : dest);
    }
  },
  async mv(args, io) {
    const { rest } = flags(args);
    if (rest.length < 2) { io.err('usage: mv src... dest\n'); return 1; }
    const dest = this.path(rest.pop());
    const destDir = await vfs.isDir(dest);
    for (const s of rest) { const sp = this.path(s); await vfs.move(sp, destDir ? vfs.join(dest, vfs.basename(sp)) : dest); }
  },
  async touch(args) { for (const x of args) { const p = this.path(x); if (await vfs.exists(p)) await vfs.write(p, await vfs.getFile(p)); else await vfs.write(p, ''); } },
  async ln(args, io) { io.err('ln: links are not supported; copying instead\n'); return COMMANDS.cp.call(this, args.filter(a => !a.startsWith('-')), io); },
  async stat(args, io) { for (const x of args) { const s = await vfs.stat(this.path(x)); io.out(`  File: ${s.path}\n  Size: ${s.size ?? '-'}  Type: ${s.kind}\nModify: ${s.mtime ? new Date(s.mtime).toISOString() : '-'}\n`); } },
  async file(args, io) { for (const x of args) { const s = await vfs.stat(this.path(x)); io.out(`${x}: ${s.kind === 'directory' ? 'directory' : isTextName(x) ? 'text' : (extOf(x) || 'data') + ' file'}\n`); } },
  async tree(args, io) {
    const { f, rest } = flags(args, 'L');
    const root = this.path(rest[0] || '.');
    const max = Number(f.L || 6);
    let dirs = 0, files = 0;
    io.out((rest[0] || '.') + '\n');
    const rec = async (p, prefix, depth) => {
      const items = (await vfs.list(p)).filter(e => f.a || !e.name.startsWith('.')).filter(e => !vfs.DEFAULT_IGNORE.has(e.name));
      for (let i = 0; i < items.length; i++) {
        const e = items[i], last = i === items.length - 1;
        io.out(`${prefix}${last ? '└── ' : '├── '}${e.name}${e.kind === 'directory' ? '/' : ''}\n`);
        if (e.kind === 'directory') { dirs++; if (depth < max) await rec(e.path, prefix + (last ? '    ' : '│   '), depth + 1); } else files++;
      }
    };
    await rec(root, '', 1);
    io.out(`\n${dirs} directories, ${files} files\n`);
  },
  async find(args, io) {
    const paths = []; let i = 0;
    while (i < args.length && !args[i].startsWith('-')) paths.push(args[i++]);
    let name = null, iname = false, type = null, maxdepth = 64, pathPat = null;
    for (; i < args.length; i++) {
      if (args[i] === '-name' || args[i] === '-iname') { iname = args[i] === '-iname'; name = args[++i]; }
      else if (args[i] === '-type') type = args[++i];
      else if (args[i] === '-maxdepth') maxdepth = Number(args[++i]);
      else if (args[i] === '-path') pathPat = args[++i];
    }
    const re = name ? new RegExp(globToRegExp(name).source, iname ? 'i' : '') : null;
    const pre = pathPat ? globToRegExp(pathPat.replace(/^\.\//, '**/')) : null;
    for (const start of paths.length ? paths : ['.']) {
      const base = this.path(start);
      for await (const e of vfs.walk(base, { includeDirs: true, maxDepth: maxdepth - 1, ignore: new Set(['node_modules', '.git']) })) {
        if (type === 'f' && e.kind !== 'file') continue;
        if (type === 'd' && e.kind !== 'directory') continue;
        if (re && !re.test(e.name)) continue;
        const shown = start === '.' ? './' + vfs.relative(base, e.path) : e.path;
        if (pre && !pre.test(shown.replace(/^\.\//, ''))) continue;
        io.out(shown + '\n');
      }
    }
  },
  async du(args, io) { const { f, rest } = flags(args); for (const x of rest.length ? rest : ['.']) { const r = await vfs.du(this.path(x)); io.out(`${fmtSize(r.bytes, f.h)}\t${x}\n`); } },
  async df(args, io) { const u = await vfs.usage(); io.out(`Filesystem  Size     Used     Avail\nHub         ${fmtSize(u.quota, true).padEnd(8)} ${fmtSize(u.used, true).padEnd(8)} ${fmtSize(u.quota - u.used, true)}\n`); },
  async grep(args, io) {
    const { f, rest } = flags(args, 'e,A,B,C,m');
    let pat = f.e ?? rest.shift();
    if (pat == null) { io.err('usage: grep [-rinlvcwE] pattern [files]\n'); return 2; }
    if (!f.E && !f.P) pat = pat.replace(/\\\|/g, '|').replace(/\\\(/g, '(').replace(/\\\)/g, ')');
    if (f.F) pat = pat.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (f.w) pat = `\\b(?:${pat})\\b`;
    const re = new RegExp(pat, f.i ? 'i' : '');
    let files = [];
    if (f.r || f.R) { for (const t of rest.length ? rest : ['.']) { const p = this.path(t); if (await vfs.isDir(p)) { for await (const e of vfs.walk(p)) if (isTextName(e.name)) files.push(vfs.relative(this.cwd, e.path)); } else files.push(t); } }
    else files = rest;
    const inputs = await readInputs(this, files, io);
    const multi = inputs.length > 1 || f.r || f.R;
    let found = false;
    for (const x of inputs) {
      const lines = x.text.split('\n');
      let count = 0;
      for (let i = 0; i < lines.length; i++) {
        const hit = re.test(lines[i]) !== !!f.v;
        if (!hit) continue;
        found = true; count++;
        if (f.l || f.c || f.q) continue;
        io.out(`${multi ? x.name + ':' : ''}${f.n ? (i + 1) + ':' : ''}${lines[i]}\n`);
        if (f.m && count >= Number(f.m)) break;
      }
      if (f.l && count) io.out(x.name + '\n');
      if (f.c) io.out(`${multi ? x.name + ':' : ''}${count}\n`);
    }
    return found ? 0 : 1;
  },
  async sed(args, io) {
    const { f, rest } = flags(args, 'e');
    const script = f.e ?? rest.shift();
    const m = /^s(.)(.*?)\1(.*?)\1([gi]*)$/.exec(script || '');
    const dm = /^(\d+)?(,(\d+|\$))?d$/.exec(script || '') || (/^\/(.*)\/d$/.exec(script || ''));
    const pm = /^(\d+)(,(\d+|\$))?p$/.exec(script || '');
    const apply = (text) => {
      if (m) { const re = new RegExp(m[2], (m[4].includes('g') ? 'g' : '') + (m[4].includes('i') ? 'i' : '')); return text.split('\n').map(l => l.replace(re, m[3].replace(/\\(\d)/g, '$$$1').replace(/&/g, '$$&'))).join('\n'); }
      if (dm && dm[0].startsWith('/')) { const re = new RegExp(dm[1]); return text.split('\n').filter(l => !re.test(l)).join('\n'); }
      if (dm) { const lines = text.split('\n'); const a = Number(dm[1] || 1), b = dm[3] === '$' ? lines.length : Number(dm[3] || a); return lines.filter((_, i) => i + 1 < a || i + 1 > b).join('\n'); }
      if (pm && f.n) { const lines = text.split('\n'); const a = Number(pm[1]), b = pm[3] === '$' ? lines.length : Number(pm[3] || a); return lines.slice(a - 1, b).join('\n') + '\n'; }
      throw new Error('only s/regex/replacement/[gi], Nd, N,Md, /re/d and -n N,Mp are supported');
    };
    if (f.i) { for (const x of rest) { const p = this.path(x); await vfs.write(p, apply(await vfs.readText(p))); } return 0; }
    for (const x of await readInputs(this, rest, io)) io.out(apply(x.text));
  },
  async sort(args, io) {
    const { f, rest } = flags(args, 'k,t');
    let lines = [];
    for (const x of await readInputs(this, rest, io)) lines.push(...x.text.replace(/\n$/, '').split('\n'));
    const key = (l) => { if (!f.k) return l; const parts = l.split(f.t || /\s+/); return parts[Number(String(f.k).split(',')[0]) - 1] ?? ''; };
    lines.sort((a, b) => f.n ? parseFloat(key(a)) - parseFloat(key(b)) : key(a).localeCompare(key(b)));
    if (f.r) lines.reverse();
    if (f.u) lines = [...new Set(lines)];
    io.out(lines.join('\n') + '\n');
  },
  async uniq(args, io) {
    const { f, rest } = flags(args);
    for (const x of await readInputs(this, rest, io)) {
      const lines = x.text.replace(/\n$/, '').split('\n'); const out = [];
      for (const l of lines) { if (out.length && out[out.length - 1].l === l) out[out.length - 1].n++; else out.push({ l, n: 1 }); }
      io.out(out.filter(o => !f.d || o.n > 1).map(o => f.c ? `${String(o.n).padStart(7)} ${o.l}` : o.l).join('\n') + '\n');
    }
  },
  async cut(args, io) {
    const { f, rest } = flags(args, 'd,f,c');
    const pick = (spec, arr) => spec.split(',').flatMap(s => { const [a, b] = s.split('-'); const from = Number(a || 1), to = b === undefined ? from : b === '' ? arr.length : Number(b); return arr.slice(from - 1, to); });
    for (const x of await readInputs(this, rest, io)) io.out(x.text.replace(/\n$/, '').split('\n').map(l => f.c ? pick(f.c, [...l]).join('') : pick(f.f || '1', l.split(f.d ?? '\t')).join(f.d ?? '\t')).join('\n') + '\n');
  },
  async tr(args, io) {
    const { f, rest } = flags(args);
    const expand = (s) => s.replace(/(\w)-(\w)/g, (_, a, b) => { let r = ''; for (let c = a.charCodeAt(0); c <= b.charCodeAt(0); c++) r += String.fromCharCode(c); return r; }).replace('[:lower:]', 'abcdefghijklmnopqrstuvwxyz').replace('[:upper:]', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ').replace('\\n', '\n');
    const a = expand(rest[0] || ''), b = expand(rest[1] || '');
    let s = io.stdin;
    if (f.d) s = [...s].filter(c => !a.includes(c)).join('');
    else s = [...s].map(c => { const i = a.indexOf(c); return i < 0 ? c : (b[Math.min(i, b.length - 1)] ?? ''); }).join('');
    io.out(s);
  },
  async rev(args, io) { for (const x of await readInputs(this, args, io)) io.out(x.text.split('\n').map(l => [...l].reverse().join('')).join('\n')); },
  async nl(args, io) { for (const x of await readInputs(this, args, io)) io.out(x.text.replace(/\n$/, '').split('\n').map((l, i) => `${String(i + 1).padStart(6)}\t${l}`).join('\n') + '\n'); },
  async tee(args, io) { const { f, rest } = flags(args); for (const x of rest) f.a ? await vfs.append(this.path(x), io.stdin) : await vfs.write(this.path(x), io.stdin); io.out(io.stdin); },
  async diff(args, io) {
    const { rest } = flags(args);
    if (rest.length !== 2) { io.err('usage: diff a b\n'); return 2; }
    const a = await vfs.readText(this.path(rest[0])), b = await vfs.readText(this.path(rest[1]));
    if (a === b) return 0;
    io.out(unifiedDiff(a, b, rest[0], rest[1]) + '\n');
    return 1;
  },
  async jq(args, io) {
    const { f, rest } = flags(args);
    const q = rest.shift() || '.';
    const data = JSON.parse((await readInputs(this, rest, io))[0]?.text || 'null');
    const get = (v, path) => {
      if (path === '.' || path === '') return [v];
      const m = /^\.(\[\]|\[(\d+)\]|([A-Za-z_][\w-]*))(.*)$/.exec(path);
      if (!m) throw new Error('unsupported jq filter (supported: .a.b, .[0], .[], keys, length)');
      if (m[1] === '[]') return (Array.isArray(v) ? v : Object.values(v || {})).flatMap(x => get(x, '.' + m[4].replace(/^\./, '')));
      const next = m[2] !== undefined ? v?.[Number(m[2])] : v?.[m[3]];
      return get(next, m[4] ? (m[4].startsWith('.') || m[4].startsWith('[') ? (m[4].startsWith('[') ? '.' + m[4] : m[4]) : '.' + m[4]) : '.');
    };
    let res;
    if (q === 'keys') res = [Object.keys(data)]; else if (q === 'length') res = [Array.isArray(data) ? data.length : Object.keys(data || {}).length]; else res = get(data, q);
    for (const r of res) io.out((f.r && typeof r === 'string' ? r : JSON.stringify(r, null, f.c ? 0 : 2)) + '\n');
  },
  async base64(args, io) {
    const { f, rest } = flags(args);
    if (rest[0]) { const b = await vfs.readBytes(this.path(rest[0])); let s = ''; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000)); io.out(btoa(s) + '\n'); return; }
    io.out(f.d ? atob(io.stdin.trim()) : btoa(unescape(encodeURIComponent(io.stdin))) + '\n');
  },
  async sha256sum(args, io) {
    for (const x of args.length ? args : ['-']) {
      const data = x === '-' ? enc.encode(io.stdin) : await vfs.readBytes(this.path(x));
      const h = [...new Uint8Array(await crypto.subtle.digest('SHA-256', data))].map(b => b.toString(16).padStart(2, '0')).join('');
      io.out(`${h}  ${x}\n`);
    }
  },
  async xargs(args, io, ctx) {
    const items = io.stdin.split(/\s+/).filter(Boolean);
    const cmd = args.length ? args : ['echo'];
    const r = await this.run([...cmd, ...items].map(s => /[\s'"]/.test(s) ? `'${s.replace(/'/g, "'\\''")}'` : s).join(' '), { ...ctx, capture: true });
    io.out(r.stdout); io.err(r.stderr); return r.code;
  },
  env(a, io) { io.out(Object.entries(this.env).map(([k, v]) => `${k}=${v}`).join('\n') + '\n'); },
  export(args) { for (const a of args) { const [k, ...v] = a.split('='); if (v.length) this.env[k] = v.join('='); } },
  unset(args) { for (const a of args) delete this.env[a]; },
  which(args, io) { for (const a of args) io.out(COMMANDS[a] ? `/bin/${a}\n` : ''); },
  date(args, io) { io.out(new Date().toString() + '\n'); },
  async sleep(args, io, ctx) { const s = Number(args[0] || 1); await new Promise((r) => { const t = setTimeout(r, s * 1000); ctx.signal?.addEventListener('abort', () => { clearTimeout(t); r(); }); }); },
  clear(a, io) { io.out('\x1b[2J\x1b[H'); },
  history(a, io) { io.out(this.history.map((h, i) => `${String(i + 1).padStart(5)}  ${h}`).join('\n') + '\n'); },
  yes(args, io) { io.out(((args.join(' ') || 'y') + '\n').repeat(100)); },
  seq(args, io) { const [a, b, c] = args.map(Number); const [from, step, to] = args.length === 1 ? [1, 1, a] : args.length === 2 ? [a, 1, b] : [a, b, c]; const out = []; for (let i = from; step > 0 ? i <= to : i >= to; i += step) out.push(i); io.out(out.join('\n') + '\n'); },
  basename(args, io) { io.out(vfs.basename(args[0] || '') .replace(new RegExp((args[1] || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$'), '') + '\n'); },
  dirname(args, io) { io.out(vfs.dirname(this.path(args[0] || '.')) + '\n'); },
  realpath(args, io) { io.out(this.path(args[0] || '.') + '\n'); },
  async curl(args, io) {
    const { f, rest } = flags(args, 'o,X,H,d,data');
    const url = rest[0];
    if (!url) { io.err('usage: curl [-sSLI] [-o file] [-X METHOD] [-H header] [-d data] url\n'); return 2; }
    if (!navigator.onLine) { io.err('curl: offline\n'); return 6; }
    const { proxiedFetch } = await import('../core/net.js');
    const headers = {};
    for (const h of [].concat(f.H || [])) { const i = h.indexOf(':'); headers[h.slice(0, i).trim()] = h.slice(i + 1).trim(); }
    const body = f.d ?? f.data;
    const r = await proxiedFetch(url, { method: f.X || (body ? 'POST' : f.I ? 'HEAD' : 'GET'), headers, body });
    if (f.I) { io.out(`HTTP ${r.status} ${r.statusText}\n` + [...r.headers].map(([k, v]) => `${k}: ${v}`).join('\n') + '\n'); return 0; }
    if (f.o) { await vfs.write(this.path(f.o), await r.blob()); return r.ok ? 0 : 22; }
    io.out(await r.text());
    return r.ok ? 0 : 22;
  },
  async wget(args, io) { const { f, rest } = flags(args, 'O'); const url = rest[0]; return COMMANDS.curl.call(this, ['-o', f.O || decodeURIComponent(new URL(url).pathname.split('/').pop() || 'index.html'), url], io); },
  async zip(args, io) {
    const { f, rest } = flags(args);
    const [out, ...ins] = rest;
    const { JSZip } = await import('../../vendor/office.mjs');
    const z = new JSZip();
    for (const i of ins) {
      const p = this.path(i);
      if (await vfs.isDir(p)) { for await (const e of vfs.walk(p, { ignore: null })) z.file(vfs.relative(this.cwd, e.path), await vfs.getFile(e.path)); }
      else z.file(i, await vfs.getFile(p));
    }
    await vfs.write(this.path(out.endsWith('.zip') ? out : out + '.zip'), await z.generateAsync({ type: 'blob', compression: 'DEFLATE' }));
    io.out(`created ${out}\n`);
  },
  async unzip(args, io) {
    const { f, rest } = flags(args, 'd');
    const { JSZip } = await import('../../vendor/office.mjs');
    const z = await JSZip.loadAsync(await vfs.getFile(this.path(rest[0])));
    const dest = this.path(f.d || '.');
    for (const [name, entry] of Object.entries(z.files)) {
      if (entry.dir) { await vfs.mkdir(vfs.join(dest, name)); continue; }
      if (f.l) { io.out(name + '\n'); continue; }
      await vfs.write(vfs.join(dest, name), await entry.async('uint8array'));
      io.out(`  inflating: ${name}\n`);
    }
  },
  async python(args, io, ctx) {
    if (!this.hooks.python) { io.err('python: not available\n'); return 127; }
    let code;
    const { f, rest } = flags(args, 'c');
    if (f.c) code = f.c; else if (rest[0]) code = await vfs.readText(this.path(rest[0])); else code = io.stdin;
    return this.hooks.python(code, io, this, { ...ctx, file: rest[0] ? this.path(rest[0]) : null, argv: rest });
  },
  async python3(a, io, ctx) { return COMMANDS.python.call(this, a, io, ctx); },
  async pip(args, io, ctx) { if (!this.hooks.pip) { io.err('pip: not available\n'); return 127; } return this.hooks.pip(args, io, this, ctx); },
  async node(args, io, ctx) {
    if (!this.hooks.js) { io.err('node: not available\n'); return 127; }
    const { f, rest } = flags(args, 'e');
    const code = f.e ?? (rest[0] ? await vfs.readText(this.path(rest[0])) : io.stdin);
    return this.hooks.js(code, io, this, ctx);
  },
  async js(a, io, ctx) { return COMMANDS.node.call(this, a, io, ctx); },
  async sh(args, io, ctx) { const src = args[0] === '-c' ? args[1] : args[0] ? await vfs.readText(this.path(args[0])) : io.stdin; const r = await this.run(src, { ...ctx, capture: true }); io.out(r.stdout); io.err(r.stderr); return r.code; },
  async bash(a, io, ctx) { return COMMANDS.sh.call(this, a, io, ctx); },
  async linux(args, io, ctx) { if (!this.hooks.linux) { io.err('linux: the Linux VM is not available\n'); return 127; } return this.hooks.linux(args, io, this, ctx); },
  async open(args, io) { if (this.hooks.open) { for (const a of args) this.hooks.open(this.path(a)); } else io.err('open: not available\n'); },
  async preview(args, io) { if (this.hooks.preview) this.hooks.preview(this.path(args[0] || 'index.html')); else io.err('preview: not available\n'); },
  async git(args, io, ctx) { if (!this.hooks.git) { io.err('git: not available\n'); return 127; } return this.hooks.git(args, io, this, ctx); },
  async npm(args, io) { io.err('npm: packages can\'t be installed in the web app. Use plain ES modules, or the Linux VM (linux npm …).\n'); return 127; },
};
