// git for the shell (isomorphic-git over the OPFS Hub). Network operations go through a CORS proxy: the user's own
// proxy (Settings → Web) when set, otherwise git.corsProxy (default: the public isomorphic-git proxy).
import * as vfs from '../core/vfs.js';
import { settings, getSecret } from '../core/settings.js';
import { unifiedDiff } from '../core/util.js';

let G = null;
const lib = async () => (G ||= await import('../../vendor/git.mjs'));
const enc = new TextEncoder(), dec = new TextDecoder();

// ---------- fs adapter (node fs.promises subset with POSIX error codes) ----------
const fail = (code, p) => { const e = new Error(`${code}: ${p}`); e.code = code; return e; };
const quiet = (p) => p.includes('/.git/') || p.endsWith('/.git');
function toStats(s) {
  const dir = s.kind === 'directory', t = s.mtime || 0;
  return { type: dir ? 'dir' : 'file', mode: dir ? 0o40755 : 0o100644, size: s.size || 0, ino: 0, mtimeMs: t, ctimeMs: t, uid: 1, gid: 1, dev: 1,
    isFile: () => !dir, isDirectory: () => dir, isSymbolicLink: () => false };
}
export const gitFs = {
  promises: {
    async readFile(p, opts) {
      let b; try { b = await vfs.readBytes(p); } catch { throw fail('ENOENT', p); }
      const e = typeof opts === 'string' ? opts : opts?.encoding;
      return e === 'utf8' || e === 'utf-8' ? dec.decode(b) : b;
    },
    async writeFile(p, data) { await vfs.write(p, typeof data === 'string' ? data : new Uint8Array(data), { silent: quiet(p) }); },
    async unlink(p) { try { await vfs.rm(p, { recursive: false, silent: quiet(p) }); } catch { throw fail('ENOENT', p); } },
    async readdir(p) { try { return (await vfs.list(p, { details: false })).map(e => e.name); } catch { throw fail('ENOENT', p); } },
    async mkdir(p) {
      if (await vfs.exists(p)) throw fail('EEXIST', p);
      if (!(await vfs.isDir(vfs.dirname(p)))) throw fail('ENOENT', vfs.dirname(p));
      await vfs.mkdir(p);
    },
    async rmdir(p) {
      let l; try { l = await vfs.list(p, { details: false }); } catch { throw fail('ENOENT', p); }
      if (l.length) throw fail('ENOTEMPTY', p);
      await vfs.rm(p, { silent: quiet(p) });
    },
    async stat(p) { try { return toStats(await vfs.stat(p)); } catch { throw fail('ENOENT', p); } },
    async lstat(p) { try { return toStats(await vfs.stat(p)); } catch { throw fail('ENOENT', p); } },
    async readlink(p) { throw fail('ENOENT', p); },
    async symlink(target, p) { await vfs.write(p, target, { silent: quiet(p) }); },
    async chmod() {},
  },
};

// ---------- network ----------
async function httpClient() {
  const { http } = await lib();
  const user = (settings.get().web?.proxyUrl || '').trim().replace(/\/+$/, '');
  if (!user) return { http, corsProxy: settings.get().git?.corsProxy ?? 'https://cors.isomorphic-git.org' };
  // The app's proxy takes ?url=<target>.
  return { http: { request: (req) => http.request({ ...req, url: `${user}/?url=${encodeURIComponent(req.url)}` }) }, corsProxy: undefined };
}
const onAuth = (url) => {
  const host = (() => { try { return new URL(url).host; } catch { return ''; } })();
  const token = /github/.test(host) ? getSecret('github_token') : /huggingface/.test(host) ? getSecret('hf_token') : /gitlab/.test(host) ? getSecret('gitlab_token') : '';
  if (!token) return { cancel: true };
  return /gitlab/.test(host) ? { username: 'oauth2', password: token } : { username: token, password: /huggingface/.test(host) ? token : 'x-oauth-basic' };
};
const author = () => ({ name: settings.get().git?.name || 'Ai Agent', email: settings.get().git?.email || 'ai-agent@localhost' });

async function findRoot(cwd) {
  const { git } = await lib();
  try { return await git.findRoot({ fs: gitFs, filepath: cwd }); } catch { return null; }
}

const STATUS = (h, w, s) => {
  if (h === 0 && w === 2 && s === 0) return '??';
  if (h === 0 && s >= 2) return 'A ';
  if (h === 1 && w === 0 && s === 0) return 'D ';
  if (h === 1 && w === 0) return ' D';
  if (h === 1 && w === 1 && s === 1) return null;
  if (h === 1 && w === 2 && s === 1) return ' M';
  if (h === 1 && w === 2 && s === 2) return 'M ';
  if (h === 1 && w === 2 && s === 3) return 'MM';
  if (h === 0 && w === 2 && s === 3) return 'AM';
  return `${h}${w}${s}`;
};

// git <args> in the jsh shell. Returns an exit code.
export async function gitCommand(args, io, shell, ctx = {}) {
  const { git } = await lib();
  const cmd = args[0];
  const rest = args.slice(1);
  const flag = (f) => { const i = rest.indexOf(f); if (i < 0) return null; const v = rest[i + 1]; rest.splice(i, 2); return v ?? true; };
  const has = (f) => { const i = rest.indexOf(f); if (i < 0) return false; rest.splice(i, 1); return true; };
  const cwd = shell.cwd;
  const needRoot = async () => { const d = await findRoot(cwd); if (!d) throw new Error('not a git repository (run git init or git clone)'); return d; };
  const fs = gitFs;
  const progress = (e) => { if (e.total) io.out(`\r${e.phase}: ${Math.round(e.loaded / e.total * 100)}%   `); };
  try {
    switch (cmd) {
      case undefined: case 'help': case '--help':
        io.out('git (isomorphic-git) commands: init, clone <url> [dir] [--depth n], status, add <paths|.>, rm <path>, commit -m <msg>, log [-n N] [--oneline], diff [path], branch [name|-d name], checkout <branch>|-b <new>, switch [-c] <branch>, restore <path>, reset --hard, remote [-v] | remote add <name> <url>, fetch, pull, push [remote] [branch] [--force], tag [name], config user.name|user.email [value], show-ref\nPush/pull use the token from Settings → Keys (github_token, gitlab_token, hf_token).\n');
        return 0;
      case 'init': {
        const dir = rest[0] ? vfs.normalize(rest[0], cwd) : cwd;
        await git.init({ fs, dir, defaultBranch: flag('-b') || 'main' });
        io.out(`Initialized empty Git repository in ${dir}/.git/\n`); return 0;
      }
      case 'clone': {
        const depth = flag('--depth'); const branch = flag('-b') || flag('--branch');
        const url = rest[0]; if (!url) { io.err('usage: git clone <url> [dir]\n'); return 2; }
        const name = (rest[1] || url.split('/').pop().replace(/\.git$/, '')).trim();
        const dir = vfs.normalize(name, cwd);
        if (await vfs.exists(dir) && (await vfs.list(dir)).length) { io.err(`fatal: destination path '${name}' already exists and is not empty\n`); return 128; }
        io.out(`Cloning into '${name}'...\n`);
        const { http, corsProxy } = await httpClient();
        await git.clone({ fs, http, dir, url, corsProxy, ref: branch || undefined, singleBranch: true, depth: depth ? +depth : undefined, onProgress: progress, onAuth: () => onAuth(url) });
        io.out('\ndone.\n'); return 0;
      }
      case 'status': {
        const dir = await needRoot();
        const branch = await git.currentBranch({ fs, dir, fullname: false }).catch(() => null);
        io.out(`On branch ${branch || '(detached)'}\n`);
        const m = await git.statusMatrix({ fs, dir });
        const lines = m.map(([f, h, w, s]) => [STATUS(h, w, s), f]).filter(([st]) => st);
        if (!lines.length) io.out('nothing to commit, working tree clean\n');
        else for (const [st, f] of lines) io.out(`${st} ${f}\n`);
        return 0;
      }
      case 'add': {
        const dir = await needRoot();
        const paths = rest.length ? rest : ['.'];
        if (paths.includes('.') || paths.includes('-A') || paths.includes('--all')) {
          for (const [f, h, w, s] of await git.statusMatrix({ fs, dir })) { if (w === 0 && h === 1) await git.remove({ fs, dir, filepath: f }); else if (w !== s) await git.add({ fs, dir, filepath: f }); }
        } else for (const p of paths) await git.add({ fs, dir, filepath: vfs.relative(dir, vfs.normalize(p, cwd)) });
        return 0;
      }
      case 'rm': { const dir = await needRoot(); for (const p of rest.filter(x => !x.startsWith('-'))) { const fp = vfs.relative(dir, vfs.normalize(p, cwd)); await git.remove({ fs, dir, filepath: fp }); if (!rest.includes('--cached')) await vfs.rm(vfs.normalize(p, cwd)).catch(() => {}); } return 0; }
      case 'commit': {
        const dir = await needRoot();
        const all = has('-a') || has('-am');
        let msg = flag('-m'); if (!msg && args.includes('-am')) msg = args[args.indexOf('-am') + 1];
        if (!msg) { io.err('error: commit message required (-m "message")\n'); return 1; }
        if (all) for (const [f, h, w, s] of await git.statusMatrix({ fs, dir })) { if (h === 1 && w === 0) await git.remove({ fs, dir, filepath: f }); else if (h === 1 && w === 2 && s !== 2) await git.add({ fs, dir, filepath: f }); }
        const sha = await git.commit({ fs, dir, message: msg, author: author() });
        io.out(`[${await git.currentBranch({ fs, dir }).catch(() => 'HEAD')} ${sha.slice(0, 7)}] ${msg.split('\n')[0]}\n`); return 0;
      }
      case 'log': {
        const dir = await needRoot();
        const n = +(flag('-n') || (rest.find(a => /^-\d+$/.test(a)) || '-20').slice(1));
        const one = has('--oneline');
        for (const c of await git.log({ fs, dir, depth: n })) {
          if (one) io.out(`${c.oid.slice(0, 7)} ${c.commit.message.split('\n')[0]}\n`);
          else io.out(`commit ${c.oid}\nAuthor: ${c.commit.author.name} <${c.commit.author.email}>\nDate:   ${new Date(c.commit.author.timestamp * 1000).toString()}\n\n    ${c.commit.message.trim().split('\n').join('\n    ')}\n\n`);
        }
        return 0;
      }
      case 'diff': {
        const dir = await needRoot();
        const only = rest.filter(a => !a.startsWith('-')).map(p => vfs.relative(dir, vfs.normalize(p, cwd)));
        const head = await git.resolveRef({ fs, dir, ref: 'HEAD' }).catch(() => null);
        for (const [f, h, w] of await git.statusMatrix({ fs, dir })) {
          if (only.length && !only.some(o => f === o || f.startsWith(o + '/'))) continue;
          if (h === 1 && w === 1) continue;
          let a = ''; if (head && h) { try { a = dec.decode((await git.readBlob({ fs, dir, oid: head, filepath: f })).blob); } catch {} }
          const b = w ? await vfs.readText(`${dir}/${f}`).catch(() => '') : '';
          if (a === b) continue;
          io.out(`diff --git a/${f} b/${f}\n${unifiedDiff(a, b, h ? 'a/' + f : '/dev/null', w ? 'b/' + f : '/dev/null')}\n`);
        }
        return 0;
      }
      case 'branch': {
        const dir = await needRoot();
        const del = flag('-d') || flag('-D');
        if (del) { await git.deleteBranch({ fs, dir, ref: del }); io.out(`Deleted branch ${del}\n`); return 0; }
        if (rest[0]) { await git.branch({ fs, dir, ref: rest[0] }); return 0; }
        const cur = await git.currentBranch({ fs, dir });
        for (const b of await git.listBranches({ fs, dir })) io.out(`${b === cur ? '* ' : '  '}${b}\n`);
        return 0;
      }
      case 'checkout': case 'switch': {
        const dir = await needRoot();
        const nb = flag('-b') || flag('-c');
        if (nb) { await git.branch({ fs, dir, ref: nb, checkout: true }); io.out(`Switched to a new branch '${nb}'\n`); return 0; }
        const ref = rest[0];
        if (!ref) { io.err(`usage: git ${cmd} <branch>\n`); return 2; }
        if (cmd === 'checkout' && (await vfs.exists(vfs.normalize(ref, cwd))) && !(await git.listBranches({ fs, dir })).includes(ref)) {
          await git.checkout({ fs, dir, force: true, filepaths: [vfs.relative(dir, vfs.normalize(ref, cwd))] }); return 0;
        }
        await git.checkout({ fs, dir, ref });
        io.out(`Switched to branch '${ref}'\n`); return 0;
      }
      case 'restore': { const dir = await needRoot(); await git.checkout({ fs, dir, force: true, filepaths: rest.map(p => vfs.relative(dir, vfs.normalize(p, cwd))) }); return 0; }
      case 'reset': {
        const dir = await needRoot();
        if (!has('--hard')) { for (const [f] of await git.statusMatrix({ fs, dir })) await git.resetIndex({ fs, dir, filepath: f }); io.out('Unstaged changes.\n'); return 0; }
        const branch = await git.currentBranch({ fs, dir });
        await git.checkout({ fs, dir, ref: branch, force: true });
        io.out(`HEAD is now at ${(await git.resolveRef({ fs, dir, ref: 'HEAD' })).slice(0, 7)}\n`); return 0;
      }
      case 'remote': {
        const dir = await needRoot();
        if (rest[0] === 'add') { await git.addRemote({ fs, dir, remote: rest[1], url: rest[2] }); return 0; }
        if (rest[0] === 'remove' || rest[0] === 'rm') { await git.deleteRemote({ fs, dir, remote: rest[1] }); return 0; }
        for (const r of await git.listRemotes({ fs, dir })) io.out(rest.includes('-v') ? `${r.remote}\t${r.url} (fetch)\n${r.remote}\t${r.url} (push)\n` : `${r.remote}\n`);
        return 0;
      }
      case 'fetch': case 'pull': case 'push': {
        const dir = await needRoot();
        const { http, corsProxy } = await httpClient();
        const force = has('--force') || has('-f');
        const remote = rest[0] || 'origin';
        const ref = rest[1] || await git.currentBranch({ fs, dir });
        const url = (await git.listRemotes({ fs, dir })).find(r => r.remote === remote)?.url;
        if (!url) { io.err(`fatal: no remote '${remote}'\n`); return 128; }
        const common = { fs, http, dir, corsProxy, remote, onProgress: progress, onAuth: () => onAuth(url), onAuthFailure: () => { io.err('\nAuthentication failed. Add a token in Settings → Keys.\n'); return { cancel: true }; } };
        if (cmd === 'fetch') await git.fetch({ ...common, ref, singleBranch: true });
        else if (cmd === 'pull') await git.pull({ ...common, ref, singleBranch: true, author: author(), fastForward: true });
        else { const r = await git.push({ ...common, ref, force }); if (!r.ok) { io.err(`\npush rejected: ${JSON.stringify(r.refs || r.error)}\n`); return 1; } }
        io.out(`\n${cmd} ${remote} ${ref}: done\n`); return 0;
      }
      case 'tag': { const dir = await needRoot(); if (rest[0]) { await git.tag({ fs, dir, ref: rest[0] }); return 0; } for (const t of await git.listTags({ fs, dir })) io.out(t + '\n'); return 0; }
      case 'config': {
        const key = rest[0], val = rest[1];
        if (!key) { io.err('usage: git config user.name|user.email [value]\n'); return 2; }
        const { setSetting } = await import('../core/settings.js');
        const k = key === 'user.name' ? 'git.name' : key === 'user.email' ? 'git.email' : null;
        if (!k) { const dir = await needRoot(); if (val == null) io.out((await git.getConfig({ fs, dir, path: key })) ?? '' + '\n'); else await git.setConfig({ fs, dir, path: key, value: val }); return 0; }
        if (val == null) io.out((k === 'git.name' ? author().name : author().email) + '\n'); else setSetting(k, val);
        return 0;
      }
      case 'show-ref': { const dir = await needRoot(); for (const b of await git.listBranches({ fs, dir })) io.out(`${await git.resolveRef({ fs, dir, ref: b })} refs/heads/${b}\n`); return 0; }
      default:
        io.err(`git: '${cmd}' is not supported here. Try: git help\n`); return 1;
    }
  } catch (e) {
    io.err(`${e.code === 'NotFoundError' ? 'fatal' : 'error'}: ${e.message || e}\n`);
    return 1;
  }
}
