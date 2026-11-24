// Network helpers: online check, optional user proxy (for sites/APIs that block browser CORS), wake lock.
import { settings } from './settings.js';

export const isOnline = () => navigator.onLine !== false;

// The proxy is a tiny Cloudflare Worker the user deploys (code in docs/proxy-worker.js): GET/POST <proxy>?url=<target>
export function proxyUrl() { return (settings.get().web?.proxyUrl || '').trim().replace(/\/+$/, ''); }

export async function proxiedFetch(url, init = {}, { forceProxy = false } = {}) {
  const proxy = proxyUrl();
  if (proxy && (forceProxy || settings.get().web?.mode === 'proxy')) {
    return fetch(`${proxy}/?url=${encodeURIComponent(url)}`, init);
  }
  try {
    return await fetch(url, init);
  } catch (e) {
    if (proxy && !init.signal?.aborted) return fetch(`${proxy}/?url=${encodeURIComponent(url)}`, init);
    throw e;
  }
}

export function friendlyNetError(e, what = 'the server') {
  if (e?.name === 'AbortError') return 'Stopped.';
  if (!isOnline()) return `You're offline, so ${what} can't be reached.`;
  if (e instanceof TypeError) return `Couldn't reach ${what}. The network failed or the site blocks requests from web apps (CORS). You can add a proxy in Settings → Web.`;
  return String(e?.message || e);
}

// Keeps the screen awake during long downloads/training (Safari 16.4+).
let wakeLock = null, wakeHolders = 0;
export async function holdWakeLock() {
  wakeHolders++;
  try { if (!wakeLock && 'wakeLock' in navigator) { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener?.('release', () => { wakeLock = null; }); } } catch {}
  let released = false;
  return () => {
    if (released) return; released = true;
    wakeHolders = Math.max(0, wakeHolders - 1);
    if (!wakeHolders && wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
  };
}
document.addEventListener?.('visibilitychange', async () => {
  if (document.visibilityState === 'visible' && wakeHolders && !wakeLock && 'wakeLock' in navigator) {
    try { wakeLock = await navigator.wakeLock.request('screen'); } catch {}
  }
});

// Parses a text/event-stream response into {event, data} objects.
export async function* sse(resp, signal) {
  const reader = resp.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  try {
    while (true) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.search(/\r?\n\r?\n/)) >= 0) {
        const chunk = buf.slice(0, i);
        buf = buf.slice(i + (buf[i] === '\r' ? 4 : 2));
        let event = 'message', data = '';
        for (const line of chunk.split(/\r?\n/)) {
          if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) data += (data ? '\n' : '') + line.slice(5).replace(/^ /, '');
        }
        if (data) yield { event, data };
      }
    }
  } finally { try { reader.releaseLock(); } catch {} }
}
