// Shared Playwright helpers: launches Chromium with WebGPU, serves the app, opens it at iPhone Duo sizes.
import { createRequire } from 'node:module';
import { start } from './serve.mjs';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

export const DUO = {
  folded: { width: 466, height: 678 },     // 5.4" outer display, ~1398x2034 px at 3x
  unfolded: { width: 669, height: 951 },   // 7.6" inner display, ~1878x2670 px (portrait)
  unfoldedLandscape: { width: 951, height: 669 },
};

let server = null;
const ARGS = ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-angle=swiftshader', '--use-webgpu-adapter=swiftshader'];
export async function setup({ port = 8091 } = {}) {
  if (!server) server = await start(port);
  const browser = await chromium.launch({ args: ARGS });
  return { browser, base: `http://localhost:${port}/ai-agent/` };
}

// A disk-backed profile: default Playwright contexts are incognito-like with a small in-memory storage quota, too
// small for suites that keep several model files in OPFS. Returns {ctx, base, close}.
export async function setupPersistent({ port = 8091, size = DUO.folded, colorScheme = 'dark' } = {}) {
  if (!server) server = await start(port);
  const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aia-profile-'));
  const ctx = await chromium.launchPersistentContext(dir, { args: ARGS, viewport: size, hasTouch: true, colorScheme });
  return { ctx, base: `http://localhost:${port}/ai-agent/`, close: async () => { await ctx.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

export async function openApp(browser, base, { size = DUO.folded, hash = '', scale = 1, reloadForIsolation = true, colorScheme = 'dark', ctx: existing } = {}) {
  const ctx = existing || await browser.newContext({ viewport: size, deviceScaleFactor: scale, hasTouch: true, isMobile: false, colorScheme });
  const page = await ctx.newPage();
  const logs = [];
  page.on('console', m => logs.push(`[${m.type()}] ${m.text()}`));
  page.on('pageerror', e => logs.push(`[pageerror] ${e.message}\n${e.stack || ''}`));
  await page.goto(base + 'index.html' + hash);
  // First load registers the service worker, which reloads once for cross-origin isolation.
  await page.waitForFunction(() => document.querySelector('.tabbar, .rail'), null, { timeout: 30000 });
  if (reloadForIsolation) {
    await page.waitForFunction(() => self.crossOriginIsolated || sessionStorage.getItem('coi-reloaded'), null, { timeout: 15000 }).catch(() => {});
    await page.waitForFunction(() => document.querySelector('.tabbar, .rail'), null, { timeout: 30000 });
  }
  return { ctx, page, logs };
}

export function stopServer() { server?.close(); server = null; }

export function assert(cond, msg) { if (!cond) throw new Error('Assertion failed: ' + msg); }
