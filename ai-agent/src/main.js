// Boot: service worker (offline + cross-origin isolation), Hub in OPFS, settings, then the UI.
import { html, render } from '../vendor/preact.mjs';
import * as vfs from './core/vfs.js';
import { bootstrapHub } from './core/hub.js';
import { loadSettings } from './core/settings.js';
import { applyTheme, probeWebGPU, refreshStorage, env } from './core/platform.js';
import { bus } from './core/bus.js';

const bootText = (t) => { const el = document.getElementById('boot-text'); if (el) el.textContent = t; };

function showFatal(err) {
  console.error(err);
  document.getElementById('app').innerHTML = `<div class="boot"><div class="boot-error"><h2>Ai Agent couldn't start</h2>
    <p class="dim">${String(err?.message || err).replace(/</g, '&lt;')}</p>
    <pre>${String(err?.stack || '').replace(/</g, '&lt;').slice(0, 1500)}</pre>
    <p class="small dim">Use Safari 17 or later (iOS 17+). Private browsing has no file storage.</p></div></div>`;
}

async function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  try {
    const reg = await navigator.serviceWorker.register('./sw.js', { scope: './' });
    // Fallback file reads for the service worker when OPFS isn't available inside it.
    navigator.serviceWorker.addEventListener('message', async (e) => {
      if (e.data?.type === 'hub-read') {
        const port = e.ports[0];
        try {
          const file = await vfs.getFile('/' + e.data.path.split('/').map(decodeURIComponent).join('/'));
          let blob = file, contentRange = null;
          const m = /bytes=(\d*)-(\d*)/.exec(e.data.range || '');
          if (m) {
            const s = m[1] === '' ? file.size - Number(m[2]) : Number(m[1]);
            const end = m[1] === '' || m[2] === '' ? file.size - 1 : Math.min(Number(m[2]), file.size - 1);
            blob = file.slice(s, end + 1); contentRange = `bytes ${s}-${end}/${file.size}`;
          }
          const bytes = await blob.arrayBuffer();
          port.postMessage({ bytes, contentRange }, [bytes]);
        } catch (err) { port.postMessage({ error: String(err?.message || err) }); }
      }
      if (e.data?.type?.startsWith('cache-engines')) bus.emit(e.data.type, e.data);
    });
    // Reload once when the worker first takes control, so this page gets cross-origin isolation headers.
    if (!self.crossOriginIsolated && !sessionStorage.getItem('coi-reloaded')) {
      const reloadIfControlled = () => {
        if (navigator.serviceWorker.controller && !self.crossOriginIsolated) {
          sessionStorage.setItem('coi-reloaded', '1');
          location.reload();
        }
      };
      if (navigator.serviceWorker.controller) reloadIfControlled();
      else navigator.serviceWorker.addEventListener('controllerchange', reloadIfControlled, { once: true });
    }
    reg.addEventListener?.('updatefound', () => {
      const w = reg.installing;
      w?.addEventListener('statechange', () => { if (w.state === 'activated' && navigator.serviceWorker.controller) bus.emit('app-updated'); });
    });
    setInterval(() => reg.update().catch(() => {}), 30 * 60 * 1000);
  } catch (e) { console.warn('Service worker registration failed', e); }
}

async function boot() {
  registerSW();
  bootText('Opening your Hub…');
  await vfs.root();
  vfs.persist();
  await bootstrapHub();
  await loadSettings();
  applyTheme();
  probeWebGPU();
  refreshStorage();
  bootText('Loading…');
  const { App } = await import('./ui/app.js');
  render(html`<${App} />`, document.getElementById('app'));
  // Share target / deep links: ?share=1&text=…  or #agent / #code / #chat / #studio / #hub
  const q = new URLSearchParams(location.search);
  if (q.get('share')) bus.emit('share', { title: q.get('title') || '', text: q.get('text') || '', url: q.get('url') || '' });
  if (q.get('shortcut-result')) bus.emit('shortcut-result', { id: q.get('id'), result: q.get('shortcut-result') });
  if (q.toString()) history.replaceState(null, '', location.pathname + location.hash);
  // First launch: install the Linux VM that ships with the app (49 MB) and run its one-time first boot in the
  // background, so `linux` in the terminal starts in about a second from then on. Runs again only if unfinished.
  setTimeout(async () => {
    try {
      const linux = await import('./runtimes/linux.js');
      if (await linux.isPrepared()) return;
      const { toast } = await import('./ui/kit.js');
      const msg = {
        installing: 'Installing the Linux VM in the background (49 MB, one time)…',
        preparing: 'Setting up the Linux VM: first boot in the background (one time, about a minute)…',
        ready: 'Linux VM ready. Type linux in the Code tab terminal: it starts in a second, offline too.',
      };
      await linux.autoSetup({ onStage: (st) => toast(msg[st], st === 'ready' ? 'ok' : 'info', st === 'ready' ? 6000 : 4000) });
    } catch (e) { console.warn('Linux VM setup did not finish; it continues on the next launch or from Settings → Storage & offline', e); }
  }, 6000);
}

window.addEventListener('unhandledrejection', (e) => console.warn('Unhandled rejection:', e.reason));
boot().catch(showFatal);
export { env };
