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

export async function install(onProgress = () => {}) {
  setState({ state: 'downloading', progress: 0, text: 'Finding the latest Alpine Linux…' });
  try {
    const yaml = await (await fetch(MIRROR + 'latest-releases.yaml')).text();
    const block = yaml.split('\n-').find(b => /flavor: alpine-virt\b/.test(b));
    const file = /\bfile: (\S+\.iso)/.exec(block || '')?.[1];
    const sha = /\bsha256: ([0-9a-f]{64})/.exec(block || '')?.[1];
    const version = /\bversion: (\S+)/.exec(block || '')?.[1];
    if (!file) throw new Error('Could not find the Alpine virt ISO on the mirror.');
    const r = await fetch(MIRROR + file);
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
      setState({ progress: p, text: `Downloading ${file} (${Math.round(got / 1e6)} MB)` }); onProgress(p);
    }
    await ws.close();
    if (sha) {
      const buf = new Uint8Array(got); let o = 0; for (const c of chunks) { buf.set(c, o); o += c.byteLength; }
      const h = [...new Uint8Array(await crypto.subtle.digest('SHA-256', buf))].map(b => b.toString(16).padStart(2, '0')).join('');
      if (h !== sha) { await vfs.rm(`${DIR}/alpine.iso`); throw new Error('Checksum mismatch: the download was corrupted. Try again.'); }
    }
    await vfs.rm(`${DIR}/state.bin`, { silent: true }).catch(() => {});
    await vfs.writeJSON(`${DIR}/manifest.json`, { iso: 'alpine.iso', file, version, sha256: sha, installed: Date.now() });
    setState({ state: 'off', progress: 1, text: `Alpine ${version} installed`, version });
  } catch (e) { setState({ state: 'error', text: String(e.message || e) }); throw e; }
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
const send = (s) => emu.serial0_send(s);

export async function boot({ fresh = false } = {}) {
  if (emu && linuxStore.get().state === 'ready') return emu;
  if (booting) return booting;
  booting = (async () => {
    const man = await vfs.readJSON(`${DIR}/manifest.json`, null);
    if (!man) await install();
    setState({ state: 'booting', text: 'Starting the Linux VM…', progress: 0 });
    const { V86 } = await import('../../vendor/v86/libv86.mjs');
    const iso = await (await vfs.getFile(`${DIR}/alpine.iso`)).arrayBuffer();
    const stateFile = !fresh && await vfs.getFile(`${DIR}/state.bin`).catch(() => null);
    serialText = '';
    emu = new V86({
      wasm_path: vendor('v86.wasm'), memory_size: MEM, vga_memory_size: 2 * 1024 * 1024,
      bios: { url: vendor('seabios.bin') }, vga_bios: { url: vendor('vgabios.bin') },
      cdrom: { buffer: iso }, boot_order: 0x123, autostart: true,
      disable_keyboard: true, disable_mouse: true, disable_speaker: true,
      ...(settings.get().linux?.network ? { net_device: { type: 'virtio', relay_url: 'fetch' } } : {}),
      ...(stateFile ? { initial_state: { buffer: await stateFile.arrayBuffer() } } : {}),
    });
    emu.add_listener('serial0-output-byte', (b) => {
      const ch = String.fromCharCode(b);
      serialText += ch;
      if (serialText.length > 400000) serialText = serialText.slice(-200000);
      for (const fn of serialListeners) fn(ch);
    });
    await new Promise((r) => emu.add_listener('emulator-ready', r));
    if (stateFile) {
      setState({ text: 'Restoring snapshot…' });
      const from = serialText.length;
      send('\necho __AIA_READY__\n');
      await waitFor(/__AIA_READY__\r?\n/, { timeout: 60000, from });
    } else {
      setState({ text: 'Booting Alpine Linux (first start takes a minute or two)…' });
      await waitFor(/login: ?$/m, { timeout: 600000 });
      send('root\n');
      await waitFor(/[#$] ?$/m, { timeout: 120000 });
      const from = serialText.length;
      send("stty -echo; export PS1=''; export TERM=dumb; mkdir -p /root/hub; cd /root; echo __AIA_READY__\n");
      await waitFor(/__AIA_READY__/, { timeout: 60000, from });
      setState({ text: 'Saving a snapshot for fast starts…' });
      try { const st = await emu.save_state(); await vfs.write(`${DIR}/state.bin`, new Uint8Array(st), { silent: true }); } catch (e) { console.warn('VM snapshot failed', e); }
    }
    globalThis.__aiaLinuxReady = true;
    setState({ state: 'ready', text: 'Linux is running', progress: 1, version: man?.version || null });
    return emu;
  })();
  try { return await booting; }
  catch (e) { setState({ state: 'error', text: String(e.message || e) }); try { emu?.destroy(); } catch {} emu = null; throw e; }
  finally { booting = null; }
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
  await boot();
  const off = onSerial(write);
  send('stty echo; export PS1="\\w # "\n');
  return { send: (s) => send(s), detach: () => { off(); send('stty -echo; export PS1=""\n'); } };
}
