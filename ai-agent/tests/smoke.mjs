// Boots the app, checks the Hub was created in OPFS, cross-origin isolation, tabs, and fold layouts.
import { setup, openApp, DUO, stopServer, assert } from './lib.mjs';

const { browser, base } = await setup();
let failed = 0;
async function test(name, fn) {
  try { await fn(); console.log('ok  ', name); }
  catch (e) { failed++; console.log('FAIL', name, '\n     ', e.message); }
}

const { page, logs, ctx } = await openApp(browser, base, { size: DUO.folded });
await test('boots and shows tab bar when folded', async () => {
  assert(await page.locator('.tabbar .tab').count() === 5, 'five tabs');
});
await test('cross-origin isolated after service worker reload', async () => {
  assert(await page.evaluate(() => self.crossOriginIsolated), 'crossOriginIsolated should be true');
});
await test('hub bootstrapped in OPFS', async () => {
  const files = await page.evaluate(async () => {
    const vfs = await import('./src/core/vfs.js');
    return { mem: await vfs.exists('/memory/MEMORY.md'), skills: (await vfs.list('/skills')).map(e => e.name), settings: await vfs.exists('/settings/settings.json') || true };
  });
  assert(files.mem, 'MEMORY.md exists');
  assert(files.skills.includes('skill-creator'), 'default skills seeded');
});
await test('vfs read/write/move/glob', async () => {
  const r = await page.evaluate(async () => {
    const vfs = await import('./src/core/vfs.js');
    await vfs.write('/workspace/t/a/b.txt', 'hello');
    await vfs.append('/workspace/t/a/b.txt', ' world');
    const t1 = await vfs.readText('/workspace/t/a/b.txt');
    await vfs.move('/workspace/t/a/b.txt', '/workspace/t/c.txt');
    const g = await vfs.glob('**/*.txt', '/workspace/t');
    const s = await vfs.createWriteStream('/workspace/t/big.bin');
    await s.write(new Uint8Array([1, 2, 3])); await s.close();
    const s2 = await vfs.createWriteStream('/workspace/t/big.bin', { offset: 3 });
    await s2.write(new Uint8Array([4, 5])); await s2.close();
    const big = [...await vfs.readBytes('/workspace/t/big.bin')];
    await vfs.rm('/workspace/t');
    return { t1, g, big, gone: !(await vfs.exists('/workspace/t')) };
  });
  assert(r.t1 === 'hello world', 'append works: ' + r.t1);
  assert(r.g.length === 1 && r.g[0] === '/workspace/t/c.txt', 'glob after move: ' + JSON.stringify(r.g));
  assert(JSON.stringify(r.big) === '[1,2,3,4,5]', 'resumable stream: ' + r.big);
  assert(r.gone, 'rm recursive');
});
await test('service worker serves hub files with ranges', async () => {
  const r = await page.evaluate(async () => {
    const vfs = await import('./src/core/vfs.js');
    await vfs.write('/models/test/x.bin', new Uint8Array([10, 11, 12, 13, 14]));
    const full = new Uint8Array(await (await fetch('hub/models/test/x.bin')).arrayBuffer());
    const part = await fetch('hub/models/test/x.bin', { headers: { Range: 'bytes=1-3' } });
    const pb = new Uint8Array(await part.arrayBuffer());
    const miss = (await fetch('hub/models/test/nope.bin')).status;
    await vfs.rm('/models/test');
    return { full: [...full], status: part.status, part: [...pb], miss };
  });
  assert(r.full.join() === '10,11,12,13,14', 'full read');
  assert(r.status === 206 && r.part.join() === '11,12,13', 'range read ' + r.status + ' ' + r.part);
  assert(r.miss === 404, '404 for missing');
});
await test('tabs switch', async () => {
  for (const t of ['Code', 'Chat', 'Studio', 'Hub', 'Agent']) {
    await page.locator('.tabbar .tab', { hasText: t }).click();
    await page.waitForTimeout(150);
  }
  assert(await page.locator('.tab.active', { hasText: 'Agent' }).count() === 1, 'agent active');
});
await ctx.close();

const u = await openApp(browser, base, { size: DUO.unfolded, reloadForIsolation: false });
await test('unfolded shows rail and two panes', async () => {
  assert(await u.page.locator('.rail').count() === 1, 'rail');
  assert(await u.page.locator('.pane').count() === 2, 'two panes');
});
await u.ctx.close();

const errs = logs.filter(l => l.startsWith('[pageerror]') || l.startsWith('[error]'));
if (errs.length) { console.log('console errors:\n' + errs.join('\n')); }
await browser.close();
stopServer();
console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);
