// Writes asset-manifest.json (files the service worker caches) and stamps a content hash into sw.js so phones
// pick up new versions. Run after any change: cd ai-agent/build && node release.mjs
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const app = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const rel = (p) => path.relative(app, p).split(path.sep).join('/');

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
}

const CORE_VENDOR = new Set(['vendor/preact.mjs', 'vendor/codemirror.mjs', 'vendor/markdown.mjs', 'vendor/xterm.mjs', 'vendor/xterm.css']);
const core = [];
const engines = [];
for (const f of [...walk(path.join(app, 'src')), ...walk(path.join(app, 'icons')), path.join(app, 'manifest.webmanifest')]) core.push(rel(f));
for (const f of walk(path.join(app, 'vendor'))) {
  const r = rel(f);
  if (r.endsWith('.map')) continue;
  (CORE_VENDOR.has(r) ? core : engines).push(r);
}
core.sort(); engines.sort();

const h = crypto.createHash('sha256');
for (const f of [...core, ...engines, 'index.html']) h.update(f).update(fs.readFileSync(path.join(app, f)));
const version = h.digest('hex').slice(0, 12);

let bytesCore = 0, bytesEngines = 0;
for (const f of core) bytesCore += fs.statSync(path.join(app, f)).size;
for (const f of engines) bytesEngines += fs.statSync(path.join(app, f)).size;

fs.writeFileSync(path.join(app, 'asset-manifest.json'), JSON.stringify({ version, built: new Date().toISOString(), bytes: { core: bytesCore, engines: bytesEngines }, core, engines }, null, 1));
const swPath = path.join(app, 'sw.js');
const sw = fs.readFileSync(swPath, 'utf8').replace(/const VERSION = '[^']*';/, `const VERSION = '${version}';`);
fs.writeFileSync(swPath, sw);
console.log(`version ${version}: core ${core.length} files (${(bytesCore / 1e6).toFixed(1)} MB), engines ${engines.length} files (${(bytesEngines / 1e6).toFixed(1)} MB)`);
