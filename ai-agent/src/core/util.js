// Small shared helpers.

export const uid = (prefix = '') => prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

export const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export function debounce(fn, ms = 200) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

export function throttle(fn, ms = 100) {
  let last = 0, t, lastArgs;
  return (...a) => {
    lastArgs = a;
    const now = Date.now();
    if (now - last >= ms) { last = now; fn(...a); }
    else { clearTimeout(t); t = setTimeout(() => { last = Date.now(); fn(...lastArgs); }, ms - (now - last)); }
  };
}

export function fmtBytes(n) {
  if (n == null || isNaN(n)) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (Math.abs(n) >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return (i === 0 ? n.toFixed(0) : n.toFixed(n < 10 ? 2 : n < 100 ? 1 : 0)) + ' ' + u[i];
}

export function fmtNum(n) {
  if (n == null) return '—';
  if (Math.abs(n) >= 1e9) return (n / 1e9).toFixed(n >= 1e10 ? 0 : 1) + 'B';
  if (Math.abs(n) >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + 'M';
  if (Math.abs(n) >= 1e3) return (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + 'k';
  return String(Math.round(n * 100) / 100);
}

export function fmtDuration(sec) {
  if (sec == null || !isFinite(sec)) return '—';
  sec = Math.max(0, Math.round(sec));
  const d = Math.floor(sec / 86400), h = Math.floor(sec % 86400 / 3600), m = Math.floor(sec % 3600 / 60), s = sec % 60;
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${s}s`;
  return `${s}s`;
}

export function fmtTime(ts) {
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  return sameDay ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

export function relTime(ts) {
  const s = (Date.now() - ts) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  if (s < 86400 * 7) return Math.floor(s / 86400) + 'd ago';
  return new Date(ts).toLocaleDateString();
}

export function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function truncate(s, n = 200) {
  s = String(s ?? '');
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

// Truncates long tool output the way Claude Code does: keeps the head and tail.
export function clip(s, max = 30000) {
  s = String(s ?? '');
  if (s.length <= max) return s;
  const head = Math.floor(max * 0.7), tail = max - head;
  return s.slice(0, head) + `\n\n… [${s.length - max} characters truncated] …\n\n` + s.slice(-tail);
}

// --- YAML front matter (subset: scalars, inline lists, block lists, one level of nesting) ---
export function parseFrontMatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text || '');
  if (!m) return { data: {}, body: text || '' };
  return { data: parseYamlLite(m[1]), body: m[2] };
}

export function parseYamlLite(src) {
  const out = {};
  const lines = src.split(/\r?\n/);
  let key = null, nested = null;
  for (const raw of lines) {
    if (!raw.trim() || raw.trim().startsWith('#')) continue;
    const indent = raw.match(/^\s*/)[0].length;
    const line = raw.trim();
    if (line.startsWith('- ') && key) {
      if (!Array.isArray(out[key])) out[key] = [];
      out[key].push(yamlScalar(line.slice(2)));
      continue;
    }
    const kv = /^([A-Za-z0-9_\-. ]+):\s*(.*)$/.exec(line);
    if (!kv) continue;
    const [, k, v] = kv;
    if (indent > 0 && nested) { out[nested][k.trim()] = yamlScalar(v); continue; }
    key = k.trim();
    if (v === '' || v === '|' || v === '>') { out[key] = v === '' ? {} : ''; nested = v === '' ? key : null; if (v !== '') nested = null; continue; }
    nested = null;
    out[key] = yamlScalar(v);
  }
  // empty nested objects that became lists stay lists; empty {} with nothing → ''
  for (const k of Object.keys(out)) if (out[k] && typeof out[k] === 'object' && !Array.isArray(out[k]) && !Object.keys(out[k]).length) out[k] = '';
  return out;
}

function yamlScalar(v) {
  v = v.trim();
  if (v.startsWith('[') && v.endsWith(']')) return v.slice(1, -1).split(',').map(x => yamlScalar(x)).filter(x => x !== '');
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) return v.slice(1, -1);
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v === 'null' || v === '~') return null;
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  return v;
}

export function toFrontMatter(data, body = '') {
  const lines = ['---'];
  for (const [k, v] of Object.entries(data)) {
    if (v == null || v === '') continue;
    if (Array.isArray(v)) lines.push(`${k}: [${v.map(x => typeof x === 'string' && /[,:\[\]]/.test(x) ? JSON.stringify(x) : x).join(', ')}]`);
    else if (typeof v === 'string' && /[:#\n]/.test(v)) lines.push(`${k}: ${JSON.stringify(v)}`);
    else lines.push(`${k}: ${v}`);
  }
  lines.push('---', '');
  return lines.join('\n') + body;
}

// --- Glob to RegExp (supports **, *, ?, {a,b}, [abc]) ---
export function globToRegExp(glob) {
  let re = '', i = 0, inGroup = false;
  while (i < glob.length) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i += 2;
        if (glob[i] === '/') { re += '(?:.*/)?'; i++; } else re += '.*';
        continue;
      }
      re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if (c === '{') { inGroup = true; re += '(?:'; }
    else if (c === '}' && inGroup) { inGroup = false; re += ')'; }
    else if (c === ',' && inGroup) re += '|';
    else if (c === '[') { const j = glob.indexOf(']', i); if (j > i) { re += glob.slice(i, j + 1); i = j + 1; continue; } re += '\\['; }
    else if ('.+^$()|\\'.includes(c)) re += '\\' + c;
    else re += c;
    i++;
  }
  return new RegExp('^' + re + '$');
}

// --- Simple line diff (Myers-lite via LCS on lines, fine for files up to a few thousand lines) ---
export function lineDiff(a, b) {
  const A = a.split('\n'), B = b.split('\n');
  const n = A.length, m = B.length;
  if (n * m > 4e6) {
    // Too large for LCS table: fall back to a coarse diff (common prefix/suffix).
    let p = 0; while (p < n && p < m && A[p] === B[p]) p++;
    let s = 0; while (s < n - p && s < m - p && A[n - 1 - s] === B[m - 1 - s]) s++;
    const out = [];
    for (let i = 0; i < p; i++) out.push({ t: ' ', s: A[i], a: i + 1, b: i + 1 });
    for (let i = p; i < n - s; i++) out.push({ t: '-', s: A[i], a: i + 1 });
    for (let j = p; j < m - s; j++) out.push({ t: '+', s: B[j], b: j + 1 });
    for (let i = n - s; i < n; i++) out.push({ t: ' ', s: A[i], a: i + 1, b: i - n + m + 1 });
    return out;
  }
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) { out.push({ t: ' ', s: A[i], a: i + 1, b: j + 1 }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ t: '-', s: A[i], a: i + 1 }); i++; }
    else { out.push({ t: '+', s: B[j], b: j + 1 }); j++; }
  }
  while (i < n) { out.push({ t: '-', s: A[i], a: i + 1 }); i++; }
  while (j < m) { out.push({ t: '+', s: B[j], b: j + 1 }); j++; }
  return out;
}

// Groups a line diff into hunks with `ctx` lines of context.
export function diffHunks(diff, ctx = 3) {
  const hunks = [];
  let cur = null, lastChange = -Infinity;
  diff.forEach((d, idx) => {
    if (d.t !== ' ') {
      if (!cur || idx - lastChange > ctx * 2) {
        cur = { lines: [] };
        hunks.push(cur);
        for (let k = Math.max(0, idx - ctx); k < idx; k++) if (!cur.lines.includes(diff[k])) cur.lines.push(diff[k]);
      } else {
        for (let k = lastChange + 1; k < idx; k++) cur.lines.push(diff[k]);
      }
      cur.lines.push(d);
      lastChange = idx;
    } else if (cur && idx - lastChange <= ctx) {
      cur.lines.push(d);
    }
  });
  return hunks;
}

export function diffStats(diff) {
  let add = 0, del = 0;
  for (const d of diff) { if (d.t === '+') add++; else if (d.t === '-') del++; }
  return { add, del };
}

export function unifiedDiff(a, b, nameA = 'a', nameB = 'b') {
  const hunks = diffHunks(lineDiff(a, b));
  const out = [`--- ${nameA}`, `+++ ${nameB}`];
  for (const h of hunks) {
    const first = h.lines[0];
    out.push(`@@ -${first.a ?? 0} +${first.b ?? 0} @@`);
    for (const l of h.lines) out.push(l.t + l.s);
  }
  return out.join('\n');
}

export const isTextName = (name) => !/\.(png|jpe?g|gif|webp|heic|bmp|ico|pdf|zip|gz|tgz|bz2|xz|7z|wasm|bin|safetensors|gguf|onnx|onnx_data|pt|pth|ckpt|npy|npz|mp3|m4a|wav|ogg|flac|mp4|mov|webm|mkv|woff2?|ttf|otf|docx|xlsx|pptx|key|pages|numbers|sqlite|db|f32|f16|i8|u8|data)$/i.test(name);

export const extOf = (name) => { const m = /\.([^./]+)$/.exec(name || ''); return m ? m[1].toLowerCase() : ''; };

export function mimeOf(name) {
  const e = extOf(name);
  return {
    html: 'text/html', htm: 'text/html', css: 'text/css', js: 'text/javascript', mjs: 'text/javascript', json: 'application/json',
    md: 'text/markdown', txt: 'text/plain', csv: 'text/csv', svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
    gif: 'image/gif', webp: 'image/webp', pdf: 'application/pdf', wasm: 'application/wasm', mp3: 'audio/mpeg', wav: 'audio/wav',
    m4a: 'audio/mp4', mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', ogg: 'audio/ogg', zip: 'application/zip',
    py: 'text/x-python', xml: 'application/xml', yaml: 'text/yaml', yml: 'text/yaml', ts: 'text/plain', jsx: 'text/javascript', tsx: 'text/plain',
  }[e] || 'application/octet-stream';
}

export async function sha256Hex(data) {
  const buf = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const h = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(h)].map(b => b.toString(16).padStart(2, '0')).join('');
}

export function tryJSON(s, fallback = null) { try { return JSON.parse(s); } catch { return fallback; } }

// Extracts the first JSON object from a string, tolerating code fences and trailing text.
export function extractJSON(s) {
  if (!s) return null;
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(s);
  if (fenced) { const v = tryJSON(fenced[1].trim()); if (v != null) return v; }
  const start = s.search(/[\[{]/);
  if (start < 0) return null;
  const open = s[start], close = open === '{' ? '}' : ']';
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === open) depth++;
    else if (c === close) { depth--; if (depth === 0) return tryJSON(s.slice(start, i + 1)); }
  }
  return null;
}

export const estimateTokens = (s) => Math.ceil(String(s || '').length / 3.6);

export function download(name, data, type = 'application/octet-stream') {
  const blob = data instanceof Blob ? data : new Blob([data], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
}

export class Emitter {
  constructor() { this._l = new Map(); }
  on(ev, fn) { if (!this._l.has(ev)) this._l.set(ev, new Set()); this._l.get(ev).add(fn); return () => this.off(ev, fn); }
  off(ev, fn) { this._l.get(ev)?.delete(fn); }
  emit(ev, ...a) { for (const fn of [...(this._l.get(ev) || [])]) { try { fn(...a); } catch (e) { console.error(e); } } for (const fn of [...(this._l.get('*') || [])]) { try { fn(ev, ...a); } catch (e) { console.error(e); } } }
}
