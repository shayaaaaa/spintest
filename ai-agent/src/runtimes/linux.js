// Linux VM: Alpine Linux (x86 "virt" ISO) running in the v86 emulator, controlled over the serial console.
// The ISO lives in Hub/runtimes/linux/; after the first boot a snapshot (state.bin) makes later starts take seconds.
import * as vfs from '../core/vfs.js';
import { createStore } from '../core/store.js';
import { settings } from '../core/settings.js';

const DIR = '/runtimes/linux';
const MIRROR = 'https://dl-cdn.alpinelinux.org/alpine/latest-stable/releases/x86/';
const MEM = 256 * 1024 * 1024;
export const linuxStore = createStore({ state: 'off', progress: 0, text: '', version: null });
const vendor = (p) => new URL('../../vendor/v86/' + p, import.meta.url).href;

let emu = null, booting = null, queue = Promise.resolve();
const serialListeners = new Set();
export const onSerial = (fn) => { serialListeners.add(fn); return () => serialListeners.delete(fn); };
const setState = (patch) => linuxStore.set(patch);

export async function isInstalled() { return !!(await vfs.readJSON(`${DIR}/manifest.json`, null))?.iso; }

// Where the ISO can come from, in order: the copy bundled with the app (ai-agent/runtimes/, same origin), the user's
// CORS proxy (Settings → Web), then the Alpine mirror directly (it sends no CORS headers, so browsers block it).
async function fetchVia(url) {
  const { proxyUrl } = await import('../core/net.js');
  const proxy = proxyUrl();
  const tries = [...(proxy ? [`${proxy}/?url=${encodeURIComponent(url)}`] : []), url];
  let last;
  for (const u of tries) { try { const r = await fetch(u); if (r.ok) return r; last = new Error(`HTTP ${r.status}`); } catch (e) { last = e; } }
  throw last;
}
async function locateISO() {
  try {
    const meta = await (await fetch(new URL('../../runtimes/alpine.json', import.meta.url), { cache: 'no-store' })).json();
    if (meta?.file) return { url: new URL('../../runtimes/alpine.iso', import.meta.url).href, ...meta, sameOrigin: true };
  } catch {}
  let yaml;
  try { yaml = await (await fetchVia(MIRROR + 'latest-releases.yaml')).text(); }
  catch { throw new Error('This copy of the app has no bundled Linux image, and the Alpine Linux mirror blocks downloads from web pages. Set your proxy in Settings → Web, or download alpine-virt-…-x86.iso in Safari and use Settings → Storage & offline → Runtimes → Import ISO.'); }
  const block = yaml.split('\n-').find(b => /flavor: alpine-virt\b/.test(b));
  const file = /\bfile: (\S+\.iso)/.exec(block || '')?.[1];
  if (!file) throw new Error('Could not find the Alpine virt ISO on the mirror.');
  return { url: MIRROR + file, file, sha256: /\bsha256: ([0-9a-f]{64})/.exec(block)?.[1], version: /\bversion: (\S+)/.exec(block)?.[1] };
}

// One install at a time (the automatic first-launch install and a tap in Settings share it).
let installing = null;
export function install(onProgress = () => {}) {
  installing ||= doInstall(onProgress).finally(() => { installing = null; });
  return installing;
}

// Installs the Linux image that ships with the app, once, in the background on first launch. Skipped when the
// user turned it off (Settings → Runtimes), when Data Saver is on, offline, or in automated test browsers.
export async function autoInstall({ force = false } = {}) {
  if (!force) {
    if (settings.get().linux?.autoInstall === false) return null;
    if (navigator.webdriver || !navigator.onLine || navigator.connection?.saveData) return null;
  }
  if (await isInstalled()) return null;
  const meta = await fetch(new URL('../../runtimes/alpine.json', import.meta.url), { cache: 'no-store' }).then(r => r.ok ? r.json() : null).catch(() => null);
  if (!meta?.file) return null; // not bundled with this deployment
  await install();
  return meta;
}

async function doInstall(onProgress) {
  setState({ state: 'downloading', progress: 0, text: 'Preparing Alpine Linux…' });
  try {
    const src = await locateISO();
    const r = src.sameOrigin ? await fetch(src.url) : await fetchVia(src.url);
    if (!r.ok || !r.body) throw new Error(`Download failed (${r.status})`);
    const total = +r.headers.get('content-length') || 0;
    const ws = await vfs.createWriteStream(`${DIR}/alpine.iso`);
    const reader = r.body.getReader();
    const chunks = [];
    let got = 0;
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      await ws.write(value); chunks.push(value); got += value.byteLength;
      const p = total ? got / total : 0;
      setState({ progress: p, text: `Downloading ${src.file} (${Math.round(got / 1e6)} MB)` }); onProgress(p);
    }
    await ws.close();
    if (src.sha256) {
      const buf = new Uint8Array(got); let o = 0; for (const c of chunks) { buf.set(c, o); o += c.byteLength; }
      const h = [...new Uint8Array(await crypto.subtle.digest('SHA-256', buf))].map(b => b.toString(16).padStart(2, '0')).join('');
      if (h !== src.sha256) { await vfs.rm(`${DIR}/alpine.iso`); throw new Error('Checksum mismatch: the download was corrupted. Try again.'); }
    }
    const version = src.version || /alpine-virt-([\d.]+)-x86/.exec(src.file)?.[1] || null;
    await vfs.rm(`${DIR}/state.bin`, { silent: true }).catch(() => {});
    await vfs.writeJSON(`${DIR}/manifest.json`, { iso: 'alpine.iso', file: src.file, version, sha256: src.sha256 || null, installed: Date.now() });
    setState({ state: 'off', progress: 1, text: `Alpine ${version || ''} installed`, version });
  } catch (e) { setState({ state: 'error', text: String(e.message || e) }); throw e; }
}

// Installs an ISO the user downloaded themselves (Files app). Checks it is an x86 ISO 9660 image.
export async function importISO(file) {
  const head = new Uint8Array(await file.slice(0x8001, 0x8006).arrayBuffer());
  if (String.fromCharCode(...head) !== 'CD001') throw new Error('That file is not an ISO image.');
  if (/aarch64|arm|x86_64/i.test(file.name)) throw new Error('Use the 32-bit x86 image (alpine-virt-…-x86.iso): the emulator runs 32-bit x86.');
  setState({ state: 'downloading', progress: 0, text: 'Importing…' });
  const ws = await vfs.createWriteStream(`${DIR}/alpine.iso`);
  const reader = file.stream().getReader();
  let got = 0;
  for (;;) { const { value, done } = await reader.read(); if (done) break; await ws.write(value); got += value.byteLength; setState({ progress: got / file.size }); }
  await ws.close();
  await vfs.rm(`${DIR}/state.bin`, { silent: true }).catch(() => {});
  const version = /alpine-\w+-([\d.]+)-x86/.exec(file.name)?.[1] || null;
  await vfs.writeJSON(`${DIR}/manifest.json`, { iso: 'alpine.iso', file: file.name, version, imported: true, installed: Date.now() });
  setState({ state: 'off', progress: 1, text: 'Linux image imported', version });
}

// Waits until the serial output (since `from`) matches re.
function waitFor(re, { timeout = 300000, from = 0 } = {}) {
  return new Promise((resolve, reject) => {
    const check = () => { const m = re.exec(serialText.slice(from)); if (m) { off(); clearTimeout(t); resolve(m); return true; } return false; };
    const off = onSerial(() => check());
    const t = setTimeout(() => { off(); reject(new Error('The Linux VM did not respond in time.')); }, timeout);
    check();
  });
}
let serialText = '';
// The serial port takes bytes: send UTF-8 so non-ASCII text survives.
const send = (s) => { const u8 = new TextEncoder().encode(s); let b = ''; for (let i = 0; i < u8.length; i += 0x8000) b += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); emu.serial0_send(b); };

export async function boot({ fresh = false } = {}) {
  if (emu && linuxStore.get().state === 'ready') return emu;
  if (booting) return booting;
  booting = (async () => {
    const man = await vfs.readJSON(`${DIR}/manifest.json`, null);
    if (!man) await install();
    const hasSnapshot = !fresh && await snapshotLooksValid();
    if (hasSnapshot) {
      try { await start(true); }
      catch (e) {
        // A snapshot from another emulator version (or a damaged one) can't be restored: boot fresh and replace it.
        console.warn('Linux VM snapshot could not be restored; booting fresh', e);
        try { emu?.destroy(); } catch {}
        emu = null;
        await vfs.rm(`${DIR}/state.bin`, { silent: true }).catch(() => {});
        await start(false);
      }
    } else await start(false);
    globalThis.__aiaLinuxReady = true;
    setState({ state: 'ready', text: 'Linux is running', progress: 1, version: man?.version || null });
    return emu;
  })();
  try { return await booting; }
  catch (e) { setState({ state: 'error', text: String(e.message || e) }); try { emu?.destroy(); } catch {} emu = null; throw e; }
  finally { booting = null; }
}

async function start(restore) {
  setState({ state: 'booting', text: restore ? 'Starting the Linux VM…' : 'Booting Alpine Linux (one time, about a minute)…', progress: 0 });
  const { V86 } = await import('../../vendor/v86/libv86.mjs');
  const iso = await (await vfs.getFile(`${DIR}/alpine.iso`)).arrayBuffer();
  const state = restore ? await (await vfs.getFile(`${DIR}/state.bin`)).arrayBuffer() : null;
  serialText = '';
  emu = new V86({
    wasm_path: vendor('v86.wasm'), memory_size: MEM, vga_memory_size: 2 * 1024 * 1024,
    bios: { url: vendor('seabios.bin') }, vga_bios: { url: vendor('vgabios.bin') },
    cdrom: { buffer: iso }, boot_order: 0x123, autostart: true,
    disable_keyboard: true, disable_mouse: true, disable_speaker: true,
    ...(settings.get().linux?.network ? { net_device: { type: 'virtio', relay_url: 'fetch' } } : {}),
    ...(state ? { initial_state: { buffer: state } } : {}),
  });
  const utf8 = new TextDecoder();
  emu.add_listener('serial0-output-byte', (b) => {
    const ch = utf8.decode(new Uint8Array([b]), { stream: true });
    if (!ch) return;
    serialText += ch;
    if (serialText.length > 400000) serialText = serialText.slice(-200000);
    for (const fn of serialListeners) fn(ch);
  });
  await new Promise((r) => emu.add_listener('emulator-ready', r));
  if (restore) {
    const from = serialText.length;
    // $((40+2)) only becomes 42 in real output, never in the terminal's echo of the typed command.
    send('\necho __AIA_$((40+2))_READY__\n');
    await waitFor(/__AIA_42_READY__\r?\n/, { timeout: 60000, from });
    return;
  }
  await waitFor(/login: ?$/m, { timeout: 600000 });
  send('root\n');
  await waitFor(/[#$] ?$/m, { timeout: 120000 });
  const from = serialText.length;
  send("stty -echo; export PS1=''; export TERM=dumb; mkdir -p /root/hub; cd /root; echo __AIA_$((40+2))_READY__\n");
  await waitFor(/__AIA_42_READY__\r?\n/, { timeout: 60000, from });
  await new Promise(r => setTimeout(r, 300)); // let the prompt settle before the snapshot
  setState({ text: 'Saving a snapshot for fast starts…' });
  try { const st = await emu.save_state(); await vfs.write(`${DIR}/state.bin`, new Uint8Array(st), { silent: true }); }
  catch (e) { console.warn('VM snapshot failed', e); }
}

// v86 snapshots start with its state magic (0x86768676) or, when compressed, the zstd magic (0xFD2FB528).
async function snapshotLooksValid() {
  const f = await vfs.getFile(`${DIR}/state.bin`).catch(() => null);
  if (!f || f.size < 1024) { if (f) await vfs.rm(`${DIR}/state.bin`, { silent: true }).catch(() => {}); return false; }
  const magic = new DataView(await f.slice(0, 4).arrayBuffer()).getUint32(0, true);
  if (magic === 0x86768676 || magic === 0xFD2FB528) return true;
  await vfs.rm(`${DIR}/state.bin`, { silent: true }).catch(() => {});
  return false;
}

export async function isPrepared() { return !!(await vfs.stat(`${DIR}/state.bin`).catch(() => null)); }

// Boots the VM once in the background so its snapshot exists (later starts take a second), then stops it again
// unless the user started using it meanwhile. Gives up after two failed attempts so it never loops on every launch.
let useCount = 0;
export async function prepare() {
  if (!(await isInstalled()) || await isPrepared()) return false;
  const man = await vfs.readJSON(`${DIR}/manifest.json`, {});
  if ((man.prepareFailures || 0) >= 2) return false;
  const usedBefore = useCount;
  try { await boot(); }
  catch (e) { await vfs.writeJSON(`${DIR}/manifest.json`, { ...man, prepareFailures: (man.prepareFailures || 0) + 1 }); throw e; }
  if (!(await isPrepared())) { await vfs.writeJSON(`${DIR}/manifest.json`, { ...man, prepareFailures: (man.prepareFailures || 0) + 1 }); }
  if (useCount === usedBefore) await shutdown();
  return true;
}

// Everything a first launch needs: copy the bundled image into the Hub, then run the one-time first boot.
// onStage('installing' | 'preparing' | 'ready'). Same opt-outs as autoInstall.
export async function autoSetup({ force = false, onStage = () => {} } = {}) {
  if (!force && (settings.get().linux?.autoInstall === false || navigator.webdriver)) return null;
  if (!(await isInstalled())) {
    onStage('installing');
    if (!(await autoInstall({ force }))) return null;
  }
  if (await isPrepared()) return 'ready';
  const man = await vfs.readJSON(`${DIR}/manifest.json`, {});
  if (!force && (man.prepareFailures || 0) >= 2) return null;
  onStage('preparing');
  await prepare();
  if (!(await isPrepared())) return null;
  onStage('ready');
  return 'ready';
}

export async function shutdown() {
  globalThis.__aiaLinuxReady = false;
  try { await emu?.destroy(); } catch {}
  emu = null;
  setState({ state: 'off', text: 'Stopped' });
}

// Runs one shell command in the VM; streams output to io.out. Returns the exit status.
async function runOne(cmd, { io, signal, timeoutMs = 600000 }) {
  const id = Math.random().toString(36).slice(2, 8);
  const marker = new RegExp(`__AIA_${id}_(\\d+)__`);
  const from = serialText.length;
  let sent = 0;
  const flush = (final) => {
    let text = serialText.slice(from).replace(/\r/g, '');
    const m = marker.exec(text);
    if (m) text = text.slice(0, m.index);
    else if (!final) { const cut = text.lastIndexOf('\n'); text = cut >= 0 ? text.slice(0, cut + 1) : ''; }
    if (text.length > sent) { io?.out(text.slice(sent)); sent = text.length; }
  };
  const off = onSerial(() => flush(false));
  try {
    send(`${cmd}\necho "__AIA_${id}_$?__"\n`);
    const abort = new Promise((_, rej) => signal?.addEventListener('abort', () => { send('\x03'); rej(new DOMException('Stopped', 'AbortError')); }, { once: true }));
    const m = await Promise.race([waitFor(marker, { timeout: timeoutMs, from }), abort]);
    flush(true);
    return +m[1];
  } finally { off(); }
}

const b64 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };
const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

// Entry point for the shell's `linux` command. Extras: `linux --put <hub-file> [vm-path]`, `linux --get <vm-file> [hub-path]`,
// `linux --status`, `linux --stop`, `linux --reset` (fresh boot, new snapshot).
export function linuxRun(cmdline, { io, cwd = '/', signal } = {}) {
  useCount++;
  const job = queue.then(async () => {
    const args = cmdline.trim().split(/\s+/);
    if (args[0] === '--status') { const s = linuxStore.get(); io?.out(`${s.state}${s.version ? ' · Alpine ' + s.version : ''} · ${s.text}\n`); return 0; }
    if (args[0] === '--stop') { await shutdown(); io?.out('Linux VM stopped.\n'); return 0; }
    if (args[0] === '--reset') { await shutdown(); await vfs.rm(`${DIR}/state.bin`, { silent: true }).catch(() => {}); await boot({ fresh: true }); io?.out('Linux VM restarted from a clean boot.\n'); return 0; }
    if (!cmdline.trim()) { io?.out('usage: linux <command>   (runs in the Alpine Linux VM; also --put, --get, --status, --stop, --reset)\n'); return 2; }
    if (linuxStore.get().state !== 'ready') io?.out(`[starting Linux VM${(await vfs.exists(`${DIR}/state.bin`)) ? '' : ': first boot takes a minute or two'}]\n`);
    await boot();
    if (args[0] === '--put') {
      const src = vfs.normalize(args[1], cwd), dst = args[2] || `/root/hub/${vfs.basename(src)}`;
      const data = b64(await vfs.readBytes(src));
      const lines = data.match(/.{1,76}/g) || [];
      const r = await runOne(`mkdir -p "$(dirname ${q(dst)})" && base64 -d > ${q(dst)} << '__AIA_EOF__'\n${lines.join('\n')}\n__AIA_EOF__`, { io: { out() {} }, signal });
      io?.out(r === 0 ? `Copied ${src} → ${dst}\n` : `Copy failed (${r})\n`); return r;
    }
    if (args[0] === '--get') {
      const src = args[1], dst = vfs.normalize(args[2] || vfs.basename(src), cwd);
      let text = '';
      const r = await runOne(`base64 ${q(src)}`, { io: { out: (s) => { text += s; } }, signal });
      if (r !== 0) { io?.err?.(text); return r; }
      const bin = atob(text.replace(/[^A-Za-z0-9+/=]/g, ''));
      const u8 = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
      await vfs.write(dst, u8);
      io?.out(`Copied ${src} → ${dst}\n`); return 0;
    }
    return runOne(cmdline, { io, signal });
  });
  queue = job.catch(() => {});
  return job;
}

// Interactive console: raw serial passthrough (for xterm). Returns a detach function.
export async function attachConsole(write) {
  useCount++;
  await boot();
  const off = onSerial(write);
  send('stty echo; export PS1="\\w # "\n');
  return { send: (s) => send(s), detach: () => { off(); send('stty -echo; export PS1=""\n'); } };
}
