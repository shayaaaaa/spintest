// Shell runtimes: git (isomorphic-git over OPFS) and the Alpine Linux VM (v86). Usage: node tests/runtimes.mjs [--only=git|linux]
import { setup, openApp, DUO, stopServer } from './lib.mjs';

const only = (process.argv.find(a => a.startsWith('--only=')) || '').slice(7);
const { browser, base } = await setup({ port: 8093 });
const { page, logs } = await openApp(browser, base, { size: DUO.folded });
page.setDefaultTimeout(1800000);
const t0 = Date.now();
let fails = 0;
const check = (name, ok, detail = '') => { if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? '  ' + String(detail).slice(0, 200).replace(/\n/g, '⏎') : ''}`); };

if (!only || only === 'git') {
  const r = await page.evaluate(async () => {
    const { createShell } = await import('./src/shell/host.js');
    const vfs = await import('./src/core/vfs.js');
    await vfs.rm('/workspace/gittest').catch(() => {});
    await vfs.mkdir('/workspace/gittest');
    const sh = createShell({ cwd: '/workspace/gittest' });
    const run = async (c) => { const r = await sh.run(c); return (r.stdout + r.stderr).trim(); };
    const out = {};
    out.init = await run('git init');
    await vfs.write('/workspace/gittest/hello.txt', 'line one\nline two\n');
    await vfs.write('/workspace/gittest/src/app.js', 'console.log(1)\n');
    out.status1 = await run('git status');
    await run('git add .');
    out.commit = await run('git commit -m "first commit"');
    out.log = await run('git log --oneline');
    await vfs.write('/workspace/gittest/hello.txt', 'line one\nline two\nnew line\n');
    out.status2 = await run('git status');
    out.diff = await run('git diff');
    out.branch = await run('git checkout -b dev');
    out.branches = await run('git branch');
    out.commit2 = await run('git commit -am "second"');
    out.log2 = await run('git log -n 5 --oneline');
    out.statusClean = await run('git status');
    return out;
  });
  check('git init', /Initialized empty Git repository/.test(r.init), r.init);
  check('git status shows untracked files', /\?\? hello\.txt/.test(r.status1) && /\?\? src\/app\.js/.test(r.status1), r.status1);
  check('git commit', /first commit/.test(r.commit), r.commit);
  check('git log', /first commit/.test(r.log), r.log);
  check('git status shows modification', / M hello\.txt/.test(r.status2), r.status2);
  check('git diff shows the added line', /\+new line/.test(r.diff), r.diff);
  check('git checkout -b / branch', /\* dev/.test(r.branches), r.branches);
  check('git commit -a and log order', /second[\s\S]*first commit/.test(r.log2), r.log2);
  check('clean tree after commit', /working tree clean/.test(r.statusClean), r.statusClean);
}

if (!only || only === 'linux') {
  const r = await page.evaluate(async () => {
    const L = await import('./src/runtimes/linux.js');
    const vfs = await import('./src/core/vfs.js');
    const out = {};
    const run = async (cmd) => { let s = ''; const code = await L.linuxRun(cmd, { io: { out: (x) => { s += x; }, err: (x) => { s += x; } }, cwd: '/workspace' }); return { code, s }; };
    // First-launch auto-install from the image bundled with the app (same origin; checksum verified).
    const urls = [];
    const origFetch = window.fetch; window.fetch = (u, ...a) => { urls.push(String(u?.url || u)); return origFetch(u, ...a); };
    out.auto = await L.autoInstall({ force: true });
    window.fetch = origFetch;
    out.autoUrls = urls;
    out.manifest = await vfs.readJSON('/runtimes/linux/manifest.json', null);
    out.autoAgain = await L.autoInstall({ force: true });
    let t = performance.now();
    out.uname = await run('uname -sm');
    out.firstBootMs = performance.now() - t;
    out.math = await run('echo $((6*7))');
    out.fail = await run('false');
    out.multi = await run('for i in 1 2 3; do echo n$i; done');
    await vfs.write('/workspace/vmfile.txt', 'from the hub ✓\n');
    out.put = await run('--put vmfile.txt /root/x.txt');
    out.cat = await run('cat /root/x.txt');
    out.utf8 = await run('echo "héllo ✓ 世界"');
    out.mk = await run('echo made-in-vm > /root/y.txt');
    out.get = await run('--get /root/y.txt vm-out.txt');
    out.got = await vfs.readText('/workspace/vm-out.txt').catch(e => 'ERR ' + e.message);
    out.cdPersist = (await run('cd /etc && pwd')).s.trim() + '|' + (await run('pwd')).s.trim();
    await L.shutdown();
    t = performance.now();
    out.again = await run('echo restored');
    out.restoreMs = performance.now() - t;
    out.snapshot = !!(await vfs.stat('/runtimes/linux/state.bin').catch(() => null));
    await L.shutdown();
    return out;
  });
  console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s] first boot ${(r.firstBootMs / 1000).toFixed(0)}s, snapshot restore ${(r.restoreMs / 1000).toFixed(1)}s`);
  check('linux: auto-install from the bundled image', r.auto?.version && r.manifest?.sha256 === r.auto.sha256 && r.autoUrls.every(u => u.startsWith('http://localhost')), JSON.stringify({ v: r.manifest?.version, urls: r.autoUrls }));
  check('linux: auto-install runs only once', r.autoAgain === null);
  check('linux: uname', r.uname.code === 0 && /Linux i686/.test(r.uname.s), r.uname.s);
  check('linux: arithmetic', r.math.s.trim() === '42', r.math.s);
  check('linux: exit status', r.fail.code === 1);
  check('linux: multi-line output', r.multi.s.trim() === 'n1\nn2\nn3', r.multi.s);
  check('linux: --put copies a Hub file in', r.put.code === 0 && r.cat.s.trim() === 'from the hub ✓', r.cat.s);
  check('linux: UTF-8 in and out of the VM', r.utf8.s.trim() === 'héllo ✓ 世界', r.utf8.s);
  check('linux: --get copies a VM file out', r.got.trim() === 'made-in-vm', r.got);
  check('linux: shell state persists between commands', r.cdPersist === '/etc|/etc', r.cdPersist);
  check('linux: snapshot saved and restored', r.snapshot && /(^|\n)restored$/.test(r.again.s.trim()) && r.restoreMs < 30000, `${r.again.s} ${(r.restoreMs / 1000).toFixed(1)}s`);
}

const errs = logs.filter(l => /pageerror/.test(l));
if (errs.length) console.log(errs.slice(0, 5).join('\n'));
console.log(fails ? `${fails} failed` : 'all passed');
await browser.close(); stopServer();
process.exit(fails ? 1 : 0);
