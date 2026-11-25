// Checks every Forge WebGPU kernel against a plain-JS reference on random data.
import { setup, openApp, DUO, stopServer } from './lib.mjs';

const { browser, base } = await setup({ port: 8098 });
const { page, logs } = await openApp(browser, base, { size: DUO.folded });
page.setDefaultTimeout(300000);
const results = await page.evaluate(async () => {
  const { GPU } = await import('./src/forge/gpu.js');
  const ops = await import('./src/forge/ops.js');
  const { NF4 } = await import('./src/forge/kernels.js');
  const g = await GPU.create();
  const out = [];
  let seed = 1;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return (seed / 2147483647) * 2 - 1; };
  const rand = (n, s = 1) => Float32Array.from({ length: n }, () => rnd() * s);
  const maxErr = (a, b) => { let m = 0; for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i]) / (1e-3 + Math.abs(b[i]))); return m; };
  const check = (name, a, b, tol = 2e-3) => { const e = maxErr(a, b); out.push({ name, ok: e < tol && Number.isFinite(e), err: e }); };
  const up = (arr) => g.fromArray(arr);
  const rd = (buf, n) => g.readF32(buf, n);
  const f16bits = (x) => { const f = new Float32Array([x]); const u = new Uint32Array(f.buffer)[0]; const s = (u >>> 16) & 0x8000; let e = ((u >>> 23) & 0xff) - 127 + 15; let m = (u >>> 13) & 0x3ff; if (e <= 0) return s; if (e >= 31) return s | 0x7c00; const r = (u >>> 12) & 1; let h = s | (e << 10) | m; if (r) h++; return h; };
  const f16val = (h) => { const s = h & 0x8000 ? -1 : 1; const e = (h >> 10) & 0x1f; const m = h & 0x3ff; return e === 0 ? s * m * 2 ** -24 : s * (1 + m / 1024) * 2 ** (e - 15); };

  // --- matmul NT (linear) f32 / f16 / nf4, plus gemv ---
  for (const [T, inn, o] of [[37, 70, 45], [3, 64, 130], [64, 128, 96]]) {
    const x = rand(T * inn), W = rand(o * inn, 0.5);
    const ref = new Float32Array(T * o);
    for (let t = 0; t < T; t++) for (let j = 0; j < o; j++) { let s = 0; for (let k = 0; k < inn; k++) s += x[t * inn + k] * W[j * inn + k]; ref[t * o + j] = s; }
    const xb = up(x), yb = g.buffer(T * o * 4);
    ops.linear(g, xb, { buf: up(W), dtype: 'f32', out: o, in: inn }, yb, T);
    check(`linear f32 T=${T}`, await rd(yb, T * o), ref);
    // f16 packed
    const packed = new Uint32Array(Math.ceil(o * inn / 2)); const Wq = new Float32Array(o * inn);
    for (let i = 0; i < o * inn; i++) { const h = f16bits(W[i]); Wq[i] = f16val(h); packed[i >> 1] |= h << ((i & 1) * 16); }
    const ref16 = new Float32Array(T * o);
    for (let t = 0; t < T; t++) for (let j = 0; j < o; j++) { let s = 0; for (let k = 0; k < inn; k++) s += x[t * inn + k] * Wq[j * inn + k]; ref16[t * o + j] = s; }
    ops.linear(g, xb, { buf: up(packed), dtype: 'f16', out: o, in: inn }, yb, T);
    check(`linear f16 T=${T}`, await rd(yb, T * o), ref16);
    if (inn % 64 === 0) {
      const q = new Uint32Array(o * inn / 8), sc = new Float32Array(o * inn / 64), Wn = new Float32Array(o * inn);
      for (let gi = 0; gi < sc.length; gi++) {
        let am = 0; for (let i = 0; i < 64; i++) am = Math.max(am, Math.abs(W[gi * 64 + i])); sc[gi] = am || 1;
        for (let i = 0; i < 64; i++) { const idx = gi * 64 + i; const v = W[idx] / sc[gi]; let best = 0; for (let c = 1; c < 16; c++) if (Math.abs(NF4[c] - v) < Math.abs(NF4[best] - v)) best = c; q[idx >> 3] |= best << ((idx & 7) * 4); Wn[idx] = NF4[best] * sc[gi]; }
      }
      const refq = new Float32Array(T * o);
      for (let t = 0; t < T; t++) for (let j = 0; j < o; j++) { let s = 0; for (let k = 0; k < inn; k++) s += x[t * inn + k] * Wn[j * inn + k]; refq[t * o + j] = s; }
      ops.linear(g, xb, { buf: up(q), scales: up(sc), dtype: 'nf4', out: o, in: inn }, yb, T);
      check(`linear nf4 T=${T}`, await rd(yb, T * o), refq);
    }
  }
  // --- backward input / weight ---
  {
    const T = 33, inn = 50, o = 70;
    const dy = rand(T * o), W = rand(o * inn), x = rand(T * inn);
    const refDx = new Float32Array(T * inn), refDw = new Float32Array(o * inn);
    for (let t = 0; t < T; t++) for (let k = 0; k < inn; k++) { let s = 0; for (let j = 0; j < o; j++) s += dy[t * o + j] * W[j * inn + k]; refDx[t * inn + k] = s; }
    for (let j = 0; j < o; j++) for (let k = 0; k < inn; k++) { let s = 0; for (let t = 0; t < T; t++) s += dy[t * o + j] * x[t * inn + k]; refDw[j * inn + k] = s; }
    const dxb = g.buffer(T * inn * 4), dwb = g.buffer(o * inn * 4);
    ops.linearBwdInput(g, up(dy), { buf: up(W), dtype: 'f32', out: o, in: inn }, dxb, T);
    ops.fill(g, dwb, o * inn, 0);
    ops.linearBwdWeight(g, up(dy), up(x), dwb, T, o, inn);
    check('linear bwd input', await rd(dxb, T * inn), refDx);
    check('linear bwd weight', await rd(dwb, o * inn), refDw);
  }
  // --- batched attention-style matmul with GQA (bDiv) ---
  {
    const T = 20, H = 4, KVH = 2, d = 16;
    const Q = rand(T * H * d), Kk = rand(T * KVH * d);
    const ref = new Float32Array(H * T * T);
    for (let h = 0; h < H; h++) { const kh = Math.floor(h / (H / KVH)); for (let t = 0; t < T; t++) for (let s = 0; s < T; s++) { let v = 0; for (let e = 0; e < d; e++) v += Q[t * H * d + h * d + e] * Kk[s * KVH * d + kh * d + e]; ref[h * T * T + t * T + s] = v; } }
    const S = g.buffer(H * T * T * 4);
    ops.matmul(g, { A: up(Q), B: up(Kk), C: S, M: T, N: T, Kd: d, batch: H, sAm: H * d, sAk: 1, sAz: d, sBk: 1, sBn: KVH * d, sBz: d, bDiv: H / KVH, sCm: T, sCz: T * T });
    check('batched QK^T GQA', await rd(S, H * T * T), ref);
  }
  // --- rmsnorm fwd/bwd vs finite differences ---
  {
    const rows = 5, D = 300, eps = 1e-5;
    const x = rand(rows * D), w = rand(D), dy = rand(rows * D);
    const ref = new Float32Array(rows * D), refdx = new Float32Array(rows * D);
    for (let r = 0; r < rows; r++) {
      let s = 0; for (let i = 0; i < D; i++) s += x[r * D + i] ** 2; const rs = 1 / Math.sqrt(s / D + eps);
      let dot = 0; for (let i = 0; i < D; i++) { ref[r * D + i] = x[r * D + i] * rs * w[i]; dot += x[r * D + i] * w[i] * dy[r * D + i]; }
      for (let i = 0; i < D; i++) refdx[r * D + i] = rs * w[i] * dy[r * D + i] - x[r * D + i] * rs ** 3 * dot / D;
    }
    const yb = g.buffer(rows * D * 4), rb = g.buffer(rows * 4), dxb = g.buffer(rows * D * 4), xb = up(x), W = { buf: up(w), dtype: 'f32' };
    ops.rmsnorm(g, xb, W, yb, rb, rows, D, eps);
    ops.rmsnormBwd(g, xb, W, up(dy), rb, dxb, rows, D);
    check('rmsnorm fwd', await rd(yb, rows * D), ref);
    check('rmsnorm bwd', await rd(dxb, rows * D), refdx, 5e-3);
  }
  // --- rope fwd then bwd = identity ---
  {
    const T = 7, H = 3, d = 8, pos0 = 5;
    const x = rand(T * H * d);
    const inv = Float32Array.from({ length: d / 2 }, (_, i) => 1 / 10000 ** (2 * i / d));
    const ref = new Float32Array(x);
    for (let t = 0; t < T; t++) for (let h = 0; h < H; h++) for (let i = 0; i < d / 2; i++) { const a = (pos0 + t) * inv[i]; const b = t * H * d + h * d; const x1 = x[b + i], x2 = x[b + i + d / 2]; ref[b + i] = x1 * Math.cos(a) - x2 * Math.sin(a); ref[b + i + d / 2] = x2 * Math.cos(a) + x1 * Math.sin(a); }
    const xb = up(x), ib = up(inv);
    ops.rope(g, xb, ib, T, H, d, pos0);
    check('rope fwd', await rd(xb, T * H * d), ref, 1e-2);
    ops.rope(g, xb, ib, T, H, d, pos0, { sign: -1 });
    check('rope bwd (inverse)', await rd(xb, T * H * d), x, 1e-2);
  }
  // --- softmax causal + backward ---
  {
    const H = 2, Tq = 6, Tk = 6, scale = 0.37;
    const S = rand(H * Tq * Tk, 3), dP = rand(H * Tq * Tk);
    const P = new Float32Array(S.length), dS = new Float32Array(S.length);
    for (let r = 0; r < H * Tq; r++) {
      const q = r % Tq; let m = -1e9; for (let j = 0; j <= q; j++) m = Math.max(m, S[r * Tk + j] * scale);
      let s = 0; for (let j = 0; j <= q; j++) s += Math.exp(S[r * Tk + j] * scale - m);
      for (let j = 0; j < Tk; j++) P[r * Tk + j] = j <= q ? Math.exp(S[r * Tk + j] * scale - m) / s : 0;
      let dot = 0; for (let j = 0; j < Tk; j++) dot += dP[r * Tk + j] * P[r * Tk + j];
      for (let j = 0; j < Tk; j++) dS[r * Tk + j] = P[r * Tk + j] * (dP[r * Tk + j] - dot) * scale;
    }
    const sb = up(S), db = up(dP);
    ops.softmax(g, sb, H * Tq, Tq, Tk, 0, scale);
    check('softmax causal', await rd(sb, S.length), P);
    ops.softmaxBwd(g, sb, db, H * Tq, Tk, scale);
    check('softmax bwd', await rd(db, S.length), dS);
  }
  // --- cross entropy ---
  {
    const R = 4, V = 1000;
    const L = rand(R * V, 4); const lab = Int32Array.from([3, -1, 999, 0]); const coef = Float32Array.from([0.5, 0.5, 0, 1]);
    const refLp = new Float32Array(R), refG = new Float32Array(R * V); // rows with coef 0 become zero gradients
    for (let r = 0; r < R; r++) {
      let m = -1e9; for (let j = 0; j < V; j++) m = Math.max(m, L[r * V + j]); let s = 0; for (let j = 0; j < V; j++) s += Math.exp(L[r * V + j] - m); const lse = m + Math.log(s);
      refLp[r] = lab[r] >= 0 ? L[r * V + lab[r]] - lse : 0;
      if (coef[r]) for (let j = 0; j < V; j++) refG[r * V + j] = coef[r] * (Math.exp(L[r * V + j] - lse) - (j === lab[r] ? 1 : 0));
    }
    const lb = up(L), lp = g.buffer(R * 4);
    ops.xent(g, lb, up(lab), up(coef), lp, R, V);
    check('xent logprob', await rd(lp, R), refLp);
    check('xent grad', await rd(lb, R * V), refG, 5e-3);
  }
  // --- embedding gather + atomic scatter-add ---
  {
    const V = 50, D = 12, T = 9;
    const E = rand(V * D); const ids = Uint32Array.from([1, 4, 4, 49, 0, 1, 1, 7, 4]); const dx = rand(T * D);
    const ref = new Float32Array(T * D), refdE = new Float32Array(V * D);
    for (let t = 0; t < T; t++) for (let c = 0; c < D; c++) { ref[t * D + c] = E[ids[t] * D + c]; refdE[ids[t] * D + c] += dx[t * D + c]; }
    const ob = g.buffer(T * D * 4), deb = g.buffer(V * D * 4), ib = up(ids);
    ops.embed(g, ib, { buf: up(E), dtype: 'f32', out: V }, ob, T, D);
    ops.fill(g, deb, V * D, 0);
    ops.embedBwd(g, ib, up(dx), deb, T, D, { rows: V });
    check('embed', await rd(ob, T * D), ref);
    check('embed bwd (atomic)', await rd(deb, V * D), refdE);
  }
  // --- adamw ---
  {
    const n = 1000; const w = rand(n), gr = rand(n), m = rand(n, 0.1), v = Float32Array.from(rand(n, 0.1), x => Math.abs(x));
    const lr = 1e-3, b1 = 0.9, b2 = 0.999, eps = 1e-8, wd = 0.01, step = 3;
    const ref = new Float32Array(n);
    for (let i = 0; i < n; i++) { const mm = b1 * m[i] + (1 - b1) * gr[i]; const vv = b2 * v[i] + (1 - b2) * gr[i] ** 2; ref[i] = w[i] - lr * ((mm / (1 - b1 ** step)) / (Math.sqrt(vv / (1 - b2 ** step)) + eps) + wd * w[i]); }
    const wb = up(w);
    ops.adamw(g, wb, up(gr), up(m), up(v), n, { step, lr, b1, b2, eps, wd });
    check('adamw', await rd(wb, n), ref);
  }
  // --- sumsq ---
  { const n = 10000; const x = rand(n); let s = 0; for (const v of x) s += v * v; const got = await ops.sumsq(g, up(x), n); out.push({ name: 'sumsq', ok: Math.abs(got - s) / s < 1e-4, err: Math.abs(got - s) / s }); }
  // --- swiglu fwd/bwd ---
  {
    const n = 500; const ga = rand(n, 3), u = rand(n), dO = rand(n);
    const sig = (x) => 1 / (1 + Math.exp(-x));
    const ref = Float32Array.from(ga, (x, i) => x * sig(x) * u[i]);
    const rdg = Float32Array.from(ga, (x, i) => dO[i] * u[i] * sig(x) * (1 + x * (1 - sig(x)))), rdu = Float32Array.from(ga, (x, i) => dO[i] * x * sig(x));
    const ob = g.buffer(n * 4), dgb = g.buffer(n * 4), dub = g.buffer(n * 4), gb = up(ga), ub = up(u);
    ops.swiglu(g, gb, ub, ob, n);
    ops.swigluBwd(g, up(dO), gb, ub, dgb, dub, n);
    check('swiglu', await rd(ob, n), ref);
    check('swiglu bwd gate', await rd(dgb, n), rdg);
    check('swiglu bwd up', await rd(dub, n), rdu);
  }
  return { out, lastError: g.lastError || null };
});
let failed = 0;
for (const r of results.out) { if (!r.ok) failed++; console.log(r.ok ? 'ok  ' : 'FAIL', r.name.padEnd(26), 'max rel err', r.err.toExponential(2)); }
if (results.lastError) { console.log('GPU error:', results.lastError); failed++; }
const errs = logs.filter(l => /pageerror|WebGPU error/.test(l));
if (errs.length) console.log(errs.slice(0, 10).join('\n'));
await browser.close(); stopServer();
console.log(failed ? `${failed} failed` : 'all kernels match');
process.exit(failed ? 1 : 0);
