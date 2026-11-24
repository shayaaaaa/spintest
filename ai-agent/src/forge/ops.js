// Forge ops: JS wrappers that encode kernel dispatches. Buffers are GPUBuffers of f32 unless a weight object says
// otherwise: W = { buf, dtype: 'f32'|'f16'|'nf4', scales?, out, in } (row-major [out][in], HF Linear layout).
import { params, F } from './gpu.js';
import * as K from './kernels.js';

const wgs = (n, per = 256) => Math.ceil(n / per);

export function matmul(g, { A, B, C, M, N, Kd, batch = 1, aOff = 0, sAm, sAk, sAz = 0, bOff = 0, sBk, sBn, sBz = 0, bDiv = 1, cOff = 0, sCm, sCn = 1, sCz = 0, acc = false, alpha = 1, bdtype = 'f32', bScales = null }) {
  const code = K.matmulCode(bdtype);
  const bufs = bdtype === 'nf4' ? [A, B, bScales, C] : [A, B, C];
  g.run('mm_' + bdtype, code, bufs, params(M, N, Kd, batch, aOff, sAm, sAk, sAz, bOff, sBk, sBn, sBz, cOff, sCm, sCn, sCz, bDiv, acc ? 1 : 0, F(alpha), 1), [Math.ceil(N / 64), Math.ceil(M / 64), batch]);
}

// y[T][out] (+)= x[T][in] · Wᵀ
export function linear(g, x, W, y, T, { xOff = 0, yOff = 0, ldy = W.out, acc = false, alpha = 1 } = {}) {
  if (T <= 4) {
    const code = K.gemvCode(W.dtype);
    const bufs = W.dtype === 'nf4' ? [x, W.buf, W.scales, y] : [x, W.buf, y];
    g.run('gemv_' + W.dtype, code, bufs, params(T, W.out, W.in, acc ? 1 : 0, xOff, yOff, ldy, F(alpha)), [W.out, 1, T]);
    return;
  }
  matmul(g, { A: x, B: W.buf, bScales: W.scales, bdtype: W.dtype, C: y, M: T, N: W.out, Kd: W.in, aOff: xOff, sAm: W.in, sAk: 1, sBk: 1, sBn: W.in, cOff: yOff, sCm: ldy, acc, alpha });
}

// dx[T][in] (+)= dy[T][out] · W
export function linearBwdInput(g, dy, W, dx, T, { acc = false, alpha = 1, dyOff = 0, ldDy = W.out } = {}) {
  matmul(g, { A: dy, B: W.buf, bScales: W.scales, bdtype: W.dtype, C: dx, M: T, N: W.in, Kd: W.out, aOff: dyOff, sAm: ldDy, sAk: 1, sBk: W.in, sBn: 1, sCm: W.in, acc, alpha });
}

// dW[out][in] (+)= dyᵀ[out][T] · x[T][in]
export function linearBwdWeight(g, dy, x, dW, T, out, inn, { acc = true, alpha = 1, dyOff = 0, ldDy = out } = {}) {
  matmul(g, { A: dy, B: x, C: dW, M: out, N: inn, Kd: T, aOff: dyOff, sAm: 1, sAk: ldDy, sBk: inn, sBn: 1, sCm: inn, acc, alpha });
}

function dummy(g) { return g._dummy ||= g.buffer(16, { label: 'dummy' }); }
function inplace(g, x, y, n, op, alpha, beta, xOff = 0, yOff = 0) {
  g.run('ewi', K.ELEMENTWISE_INPLACE, [x, y || dummy(g)], params(n, op, F(alpha), F(beta), xOff, yOff, 0, 0), [wgs(n)]);
}
// c = alpha*a + beta*b (c may be a: then done in place)
export function axpby(g, a, b, c, n, alpha = 1, beta = 1, { aOff = 0, bOff = 0, cOff = 0 } = {}) {
  if (c === a && aOff === cOff) { if (b === a) return inplace(g, a, null, n, 3, alpha + beta, 0, aOff); return inplace(g, a, b, n, 0, alpha, beta, aOff, bOff); }
  if (c === b && bOff === cOff) return inplace(g, b, a, n, 0, beta, alpha, bOff, aOff);
  g.run('ew', K.ELEMENTWISE, [a, b, c], params(n, 0, F(alpha), F(beta), aOff, bOff, cOff, 0), [wgs(n)]);
}
export const add = (g, a, b, c, n) => axpby(g, a, b, c, n, 1, 1);
export function mul(g, a, b, c, n) {
  if (c === a) return inplace(g, a, b, n, 1, 1, 0);
  if (c === b) return inplace(g, b, a, n, 1, 1, 0);
  g.run('ew', K.ELEMENTWISE, [a, b, c], params(n, 1, F(1), F(0), 0, 0, 0, 0), [wgs(n)]);
}
export function swiglu(g, gate, up, out, n) { g.run('ew', K.ELEMENTWISE, [gate, up, out], params(n, 2, F(1), F(0), 0, 0, 0, 0), [wgs(n)]); }
export function scale(g, a, c, n, alpha) {
  if (c === a) return inplace(g, a, null, n, 3, alpha, 0);
  g.run('ew', K.ELEMENTWISE, [a, dummy(g), c], params(n, 3, F(alpha), F(0), 0, 0, 0, 0), [wgs(n)]);
}
export function copy(g, a, c, n, { aOff = 0, cOff = 0 } = {}) { g.run('ew', K.ELEMENTWISE, [a, dummy(g), c], params(n, 3, F(1), F(0), aOff, 0, cOff, 0), [wgs(n)]); }
export function fill(g, a, n, v = 0, off = 0) { inplace(g, a, null, n, 4, v, 0, off); }
export function swigluBwd(g, dOut, gate, up, dGate, dUp, n) { g.run('swiglu_bwd', K.SWIGLU_BWD, [dOut, gate, up, dGate, dUp], params(n), [wgs(n)]); }

export function rmsnorm(g, x, w, y, rstd, rows, D, eps, { xOff = 0, yOff = 0, plusOne = false } = {}) {
  const dt = w ? w.dtype : 'f32';
  g.run('rms_' + dt, K.RMSNORM_FWD(dt), [x, w ? w.buf : x, y, rstd], params(rows, D, F(eps), xOff, yOff, w ? 1 : 0, plusOne ? 1 : 0, 0), [rows]);
}
export function rmsnormBwd(g, x, w, dy, rstd, dx, rows, D, { xOff = 0, dxOff = 0, acc = false, plusOne = false } = {}) {
  const dt = w ? w.dtype : 'f32';
  g.run('rmsb_' + dt, K.RMSNORM_BWD(dt), [x, w ? w.buf : x, dy, rstd, dx], params(rows, D, xOff, dxOff, acc ? 1 : 0, w ? 1 : 0, plusOne ? 1 : 0, 0), [rows]);
}
export function rmsnormDW(g, x, dy, rstd, dw, rows, D, { xOff = 0 } = {}) { g.run('rms_dw', K.RMSNORM_DW, [x, dy, rstd, dw], params(rows, D, xOff, 0), [wgs(D)]); }

export function rope(g, x, inv, T, H, d, pos0, { sign = 1, off = 0, rowStride = H * d } = {}) {
  g.run('rope', K.ROPE, [x, inv], params(T, H, d, pos0, F(sign), off, rowStride, 0), [wgs(T * H * d / 2)]);
}

export function softmax(g, S, rows, Tq, Tk, pos0, scale, causal = true) {
  g.run('softmax', K.SOFTMAX_FWD, [S], params(rows, Tq, Tk, pos0, F(scale), causal ? 1 : 0, 0, 0), [rows]);
}
export function softmaxBwd(g, P, dP, rows, Tk, scale) { g.run('softmax_bwd', K.SOFTMAX_BWD, [P, dP], params(rows, Tk, F(scale), 0), [rows]); }

export function embed(g, ids, E, out, T, D, { rowStart = 0, rows, scale = 1 } = {}) {
  g.run('embed_' + E.dtype, K.EMBED(E.dtype), [ids, E.buf, out], params(T, D, rowStart, rows ?? E.out, F(scale), 0, 0, 0), [wgs(T * D)]);
}
export function embedBwd(g, ids, dx, dE, T, D, { rowStart = 0, rows } = {}) { g.run('embed_bwd', K.EMBED_BWD, [ids, dx, dE], params(T, D, rowStart, rows), [wgs(T * D)]); }

export function xent(g, logits, labels, coef, lp, R, V) { g.run('xent', K.XENT, [logits, labels, coef, lp], params(R, V), [R]); }

export function adamw(g, w, grad, m, v, n, { step, lr, b1 = 0.9, b2 = 0.999, eps = 1e-8, wd = 0, gscale = 1 }) {
  g.run('adamw', K.ADAMW, [w, grad, m, v], params(n, step, F(lr), F(b1), F(b2), F(eps), F(wd), F(gscale)), [wgs(n)]);
}

export async function sumsq(g, x, n) {
  const parts = Math.ceil(n / 4096);
  const out = g.temp(parts * 4);
  g.run('sumsq', K.SUMSQ, [x, out], params(n, 0), [parts]);
  const arr = await g.readF32(out, parts);
  g.release(out);
  let s = 0; for (const v of arr) s += v;
  return s;
}

// Sum of squares over many buffers with a single readback. list: [[buf, n], ...]
export async function sumsqMany(g, list) {
  const total = list.reduce((a, [, n]) => a + Math.ceil(n / 4096), 0);
  if (!total) return 0;
  const out = g.temp(total * 4);
  let off = 0;
  for (const [x, n] of list) { const parts = Math.ceil(n / 4096); g.run('sumsq', K.SUMSQ, [x, out], params(n, off), [parts]); off += parts; }
  const arr = await g.readF32(out, total);
  g.release(out);
  let s = 0; for (const v of arr) s += v;
  return s;
}

export function biasAdd(g, x, b, T, D, { off = 0, ld = D } = {}) { g.run('bias_' + b.dtype, K.BIAS_ADD(b.dtype), [x, b.buf], params(T, D, off, ld), [wgs(T * D)]); }
export function colsum(g, dy, db, T, D) { g.run('colsum', K.COLSUM, [dy, db], params(T, D), [wgs(D)]); }
export function copy2d(g, src, dst, rows, cols, { srcOff = 0, srcLd = cols, dstOff = 0, dstLd = cols } = {}) {
  g.run('copy2d', K.COPY2D, [src, dst], params(rows, cols, srcOff, srcLd, dstOff, dstLd, 0, 0), [wgs(rows * cols)]);
}
