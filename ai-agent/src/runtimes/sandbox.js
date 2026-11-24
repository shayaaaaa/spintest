// Runs untrusted JavaScript (agent code, custom tools, hooks) in an opaque-origin sandboxed iframe:
// no access to the Hub, API keys or the app. A tiny RPC lets the code call back for explicitly allowed operations.
let frame = null, ready = null, seq = 0;
const waits = new Map();
let rpcHandler = null;

const RUNNER = `<!doctype html><meta charset="utf-8"><script>
const pending = new Map(); let rpcSeq = 0;
function rpc(method, args) { const id = ++rpcSeq; return new Promise((res, rej) => { pending.set(id, { res, rej }); parent.postMessage({ type: 'rpc', id, method, args }, '*'); }); }
const fmt = (a) => a.map(x => { if (typeof x === 'string') return x; try { return JSON.stringify(x, null, 2); } catch { return String(x); } }).join(' ');
addEventListener('message', async (e) => {
  const d = e.data || {};
  if (d.type === 'rpc-result') { const p = pending.get(d.id); if (p) { pending.delete(d.id); d.error ? p.rej(new Error(d.error)) : p.res(d.result); } return; }
  if (d.type !== 'run') return;
  const logs = [];
  const con = { log: (...a) => logs.push(fmt(a)), info: (...a) => logs.push(fmt(a)), warn: (...a) => logs.push('warn: ' + fmt(a)), error: (...a) => logs.push('error: ' + fmt(a)), table: (x) => logs.push(fmt([x])) };
  const ctx = { readFile: (p) => rpc('readFile', [p]), writeFile: (p, t) => rpc('writeFile', [p, t]), listDir: (p) => rpc('listDir', [p]), fetch: (u, o) => rpc('fetch', [u, o]), env: d.env || {} };
  const started = performance.now();
  try {
    const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
    let result;
    if (d.mode === 'tool') {
      const fn = new AsyncFunction('console', 'ctx', 'input', d.code + '\\n;return typeof run === "function" ? await run(input, ctx) : undefined;');
      result = await fn(con, ctx, d.input);
    } else if (d.mode === 'hook') {
      const fn = new AsyncFunction('console', 'ctx', 'event', d.code);
      result = await fn(con, ctx, d.input);
    } else {
      const fn = new AsyncFunction('console', 'ctx', 'args', d.code);
      result = await fn(con, ctx, d.input);
    }
    parent.postMessage({ type: 'done', id: d.id, logs, result: result === undefined ? undefined : JSON.parse(JSON.stringify(result ?? null)), ms: performance.now() - started }, '*');
  } catch (err) {
    parent.postMessage({ type: 'done', id: d.id, logs, error: (err && err.stack) ? String(err.stack).split('\\n').slice(0, 6).join('\\n') : String(err), ms: performance.now() - started }, '*');
  }
});
parent.postMessage({ type: 'ready' }, '*');
<\/script>`;

function ensure() {
  if (ready) return ready;
  ready = new Promise((resolve) => {
    frame = document.createElement('iframe');
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.style.display = 'none';
    frame.srcdoc = RUNNER;
    addEventListener('message', async (e) => {
      if (e.source !== frame?.contentWindow) return;
      const d = e.data || {};
      if (d.type === 'ready') resolve();
      else if (d.type === 'done') { const w = waits.get(d.id); if (w) { waits.delete(d.id); clearTimeout(w.timer); w.resolve(d); } }
      else if (d.type === 'rpc') {
        try { const result = await (rpcHandler ? rpcHandler(d.method, d.args) : Promise.reject(new Error('not allowed'))); frame.contentWindow.postMessage({ type: 'rpc-result', id: d.id, result }, '*'); }
        catch (err) { frame.contentWindow.postMessage({ type: 'rpc-result', id: d.id, error: String(err.message || err) }, '*'); }
      }
    });
    document.body.appendChild(frame);
  });
  return ready;
}

function reset() { frame?.remove(); frame = null; ready = null; for (const w of waits.values()) w.resolve({ error: 'Sandbox reset', logs: [] }); waits.clear(); }

// mode: 'script' | 'tool' | 'hook'. rpc: async (method, args) => result (permission-checked by the caller).
export async function runSandboxed(code, { mode = 'script', input, timeoutMs = 30000, rpc, env } = {}) {
  await ensure();
  rpcHandler = rpc || null;
  const id = ++seq;
  return new Promise((resolve) => {
    const timer = setTimeout(() => { reset(); resolve({ error: `Timed out after ${timeoutMs / 1000}s (the sandbox was restarted).`, logs: [] }); }, timeoutMs);
    waits.set(id, { resolve, timer });
    frame.contentWindow.postMessage({ type: 'run', id, code, mode, input, env }, '*');
  });
}
