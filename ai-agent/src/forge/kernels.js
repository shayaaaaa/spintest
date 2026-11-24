// WGSL compute kernels for Forge. All math is f32; frozen weights may be stored as packed f16 (two halves per u32,
// decoded with unpack2x16float, which is core WGSL — no shader-f16 needed) or 4-bit NF4 (QLoRA) with per-64 scales.

export const NF4 = [-1.0, -0.6961928009986877, -0.5250730514526367, -0.39491748809814453, -0.28444138169288635, -0.18477343022823334, -0.09105003625154495, 0.0, 0.07958029955625534, 0.16093020141124725, 0.24611230194568634, 0.33791524171829224, 0.44070982933044434, 0.5626170039176941, 0.7229568362236023, 1.0];

const nf4Const = `const NF4 = array<f32, 16>(${NF4.map(v => v.toFixed(9)).join(', ')});`;

// loadB(i): reads element i of a logically f32 tensor stored as f32 | f16 | nf4
export function loader(name, dtype, binding, scaleBinding) {
  if (dtype === 'f32') return `@group(0) @binding(${binding}) var<storage, read> ${name}: array<f32>;
fn load_${name}(i: u32) -> f32 { return ${name}[i]; }`;
  if (dtype === 'f16') return `@group(0) @binding(${binding}) var<storage, read> ${name}: array<u32>;
fn load_${name}(i: u32) -> f32 { let v = unpack2x16float(${name}[i >> 1u]); return select(v.x, v.y, (i & 1u) == 1u); }`;
  if (dtype === 'nf4') return `${nf4Const}
@group(0) @binding(${binding}) var<storage, read> ${name}: array<u32>;
@group(0) @binding(${scaleBinding}) var<storage, read> ${name}_s: array<f32>;
fn load_${name}(i: u32) -> f32 { let w = ${name}[i >> 3u]; let q = (w >> ((i & 7u) * 4u)) & 15u; return NF4[q] * ${name}_s[i >> 6u]; }`;
  throw new Error('dtype ' + dtype);
}

// ---------- batched strided matmul ----------
// C[z][m][n] (+)= alpha * sum_k A[z][m][k] * B[z/bDiv][k][n], with arbitrary strides (covers NN, NT, TN).
export function matmulCode(bdtype) {
  const sb = bdtype === 'nf4';
  return `
struct P { M: u32, N: u32, K: u32, batch: u32,
  aOff: u32, sAm: u32, sAk: u32, sAz: u32,
  bOff: u32, sBk: u32, sBn: u32, sBz: u32,
  cOff: u32, sCm: u32, sCn: u32, sCz: u32,
  bDiv: u32, acc: u32, alpha: f32, cDiv: u32 };
@group(0) @binding(0) var<storage, read> A: array<f32>;
${loader('B', bdtype, 1, 2)}
@group(0) @binding(${sb ? 3 : 2}) var<storage, read_write> C: array<f32>;
@group(0) @binding(${sb ? 4 : 3}) var<uniform> p: P;
var<workgroup> As: array<f32, 1024>;
var<workgroup> Bt: array<f32, 1024>;
@compute @workgroup_size(16, 16)
fn main(@builtin(workgroup_id) wg: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>) {
  let z = wg.z;
  let m0 = wg.y * 64u;
  let n0 = wg.x * 64u;
  let tid = lid.y * 16u + lid.x;
  var acc: array<f32, 16>;
  let aBase = p.aOff + z * p.sAz;
  let bBase = p.bOff + (z / p.bDiv) * p.sBz;
  for (var k0 = 0u; k0 < p.K; k0 = k0 + 16u) {
    for (var i = 0u; i < 4u; i = i + 1u) {
      let e = tid * 4u + i;
      let mm = e / 16u; let kk = e % 16u;
      let gm = m0 + mm; let gk = k0 + kk;
      var va = 0.0;
      if (gm < p.M && gk < p.K) { va = A[aBase + gm * p.sAm + gk * p.sAk]; }
      As[kk * 64u + mm] = va;
      let nn = e / 16u;
      let gn = n0 + nn;
      var vb = 0.0;
      if (gn < p.N && gk < p.K) { vb = load_B(bBase + gk * p.sBk + gn * p.sBn); }
      Bt[kk * 64u + nn] = vb;
    }
    workgroupBarrier();
    for (var kk = 0u; kk < 16u; kk = kk + 1u) {
      let ar = kk * 64u + lid.y * 4u;
      let br = kk * 64u + lid.x * 4u;
      let a0 = As[ar]; let a1 = As[ar + 1u]; let a2 = As[ar + 2u]; let a3 = As[ar + 3u];
      let b0 = Bt[br]; let b1 = Bt[br + 1u]; let b2 = Bt[br + 2u]; let b3 = Bt[br + 3u];
      acc[0] += a0 * b0; acc[1] += a0 * b1; acc[2] += a0 * b2; acc[3] += a0 * b3;
      acc[4] += a1 * b0; acc[5] += a1 * b1; acc[6] += a1 * b2; acc[7] += a1 * b3;
      acc[8] += a2 * b0; acc[9] += a2 * b1; acc[10] += a2 * b2; acc[11] += a2 * b3;
      acc[12] += a3 * b0; acc[13] += a3 * b1; acc[14] += a3 * b2; acc[15] += a3 * b3;
    }
    workgroupBarrier();
  }
  let cBase = p.cOff + (z / p.cDiv) * p.sCz;
  for (var i = 0u; i < 4u; i = i + 1u) {
    let gm = m0 + lid.y * 4u + i;
    if (gm >= p.M) { continue; }
    for (var j = 0u; j < 4u; j = j + 1u) {
      let gn = n0 + lid.x * 4u + j;
      if (gn >= p.N) { continue; }
      let idx = cBase + gm * p.sCm + gn * p.sCn;
      let v = p.alpha * acc[i * 4u + j];
      if (p.acc == 1u) { C[idx] = C[idx] + v; } else { C[idx] = v; }
    }
  }
}`;
}

// ---------- matrix-vector (decode, M small): y[m][n] (+)= alpha * sum_k x[m][k] * W[n][k] ----------
export function gemvCode(bdtype) {
  const sb = bdtype === 'nf4';
  return `
struct P { M: u32, N: u32, K: u32, acc: u32, xOff: u32, yOff: u32, ldy: u32, alpha: f32 };
@group(0) @binding(0) var<storage, read> X: array<f32>;
${loader('W', bdtype, 1, 2)}
@group(0) @binding(${sb ? 3 : 2}) var<storage, read_write> Y: array<f32>;
@group(0) @binding(${sb ? 4 : 3}) var<uniform> p: P;
var<workgroup> red: array<f32, 64>;
@compute @workgroup_size(64)
fn main(@builtin(workgroup_id) wg: vec3<u32>, @builtin(num_workgroups) nw: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>) {
  let n = wg.x + wg.y * nw.x;
  if (n >= p.N) { return; }
  let m = wg.z;
  var s = 0.0;
  let wb = n * p.K;
  let xb = p.xOff + m * p.K;
  for (var k = lid.x; k < p.K; k = k + 64u) { s += X[xb + k] * load_W(wb + k); }
  red[lid.x] = s;
  workgroupBarrier();
  for (var w = 32u; w > 0u; w = w >> 1u) { if (lid.x < w) { red[lid.x] += red[lid.x + w]; } workgroupBarrier(); }
  if (lid.x == 0u) {
    let idx = p.yOff + m * p.ldy + n;
    let v = p.alpha * red[0];
    if (p.acc == 1u) { Y[idx] = Y[idx] + v; } else { Y[idx] = v; }
  }
}`;
}

// ---------- elementwise ----------
// Out of place: C = op(A, B). A and B are read-only and must not be C.
export const ELEMENTWISE = `
struct P { n: u32, op: u32, alpha: f32, beta: f32, aOff: u32, bOff: u32, cOff: u32, pad: u32 };
@group(0) @binding(0) var<storage, read> A: array<f32>;
@group(0) @binding(1) var<storage, read> B: array<f32>;
@group(0) @binding(2) var<storage, read_write> C: array<f32>;
@group(0) @binding(3) var<uniform> p: P;
fn sig(x: f32) -> f32 { return 1.0 / (1.0 + exp(-x)); }
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) nw: vec3<u32>) {
  let i = gid.x + gid.y * nw.x * 256u;
  if (i >= p.n) { return; }
  let a = A[p.aOff + i];
  let b = B[p.bOff + i];
  switch p.op {
    case 0u: { C[p.cOff + i] = p.alpha * a + p.beta * b; }                    // axpby
    case 1u: { C[p.cOff + i] = a * b; }                                       // mul
    case 2u: { let s = sig(a); C[p.cOff + i] = a * s * b; }                   // swiglu: silu(gate) * up
    case 3u: { C[p.cOff + i] = p.alpha * a; }                                  // scale / copy
    default: { }
  }
}`;

// In place: X = op(X, Y). Y is read-only (pass a dummy buffer when unused).
export const ELEMENTWISE_INPLACE = `
struct P { n: u32, op: u32, alpha: f32, beta: f32, xOff: u32, yOff: u32, pad0: u32, pad1: u32 };
@group(0) @binding(0) var<storage, read_write> X: array<f32>;
@group(0) @binding(1) var<storage, read> Y: array<f32>;
@group(0) @binding(2) var<uniform> p: P;
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) nw: vec3<u32>) {
  let i = gid.x + gid.y * nw.x * 256u;
  if (i >= p.n) { return; }
  let k = p.xOff + i;
  switch p.op {
    case 0u: { X[k] = p.alpha * X[k] + p.beta * Y[p.yOff + i]; }   // axpby in place
    case 1u: { X[k] = X[k] * Y[p.yOff + i]; }                      // mul in place
    case 3u: { X[k] = p.alpha * X[k]; }                            // scale in place
    case 4u: { X[k] = p.alpha; }                                   // fill
    default: { }
  }
}`;

// SwiGLU backward: given dOut (A), gate (B), up (C) -> writes dGate into B? no: separate outputs.
export const SWIGLU_BWD = `
struct P { n: u32, pad0: u32, pad1: u32, pad2: u32 };
@group(0) @binding(0) var<storage, read> dO: array<f32>;
@group(0) @binding(1) var<storage, read> G: array<f32>;
@group(0) @binding(2) var<storage, read> U: array<f32>;
@group(0) @binding(3) var<storage, read_write> dG: array<f32>;
@group(0) @binding(4) var<storage, read_write> dU: array<f32>;
@group(0) @binding(5) var<uniform> p: P;
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) nw: vec3<u32>) {
  let i = gid.x + gid.y * nw.x * 256u;
  if (i >= p.n) { return; }
  let g = G[i]; let u = U[i]; let d = dO[i];
  let s = 1.0 / (1.0 + exp(-g));
  let silu = g * s;
  dU[i] = d * silu;
  dG[i] = d * u * s * (1.0 + g * (1.0 - s));
}`;

// ---------- RMSNorm (rows of D) ----------
export const RMSNORM_FWD = (wdtype) => `
struct P { rows: u32, D: u32, eps: f32, xOff: u32, yOff: u32, hasW: u32, plusOne: u32, pad: u32 };
@group(0) @binding(0) var<storage, read> X: array<f32>;
${loader('W', wdtype, 1, 9)}
@group(0) @binding(2) var<storage, read_write> Y: array<f32>;
@group(0) @binding(3) var<storage, read_write> R: array<f32>;
@group(0) @binding(4) var<uniform> p: P;
var<workgroup> red: array<f32, 256>;
@compute @workgroup_size(256)
fn main(@builtin(workgroup_id) wg: vec3<u32>, @builtin(num_workgroups) nw: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>) {
  let r = wg.x + wg.y * nw.x;
  if (r >= p.rows) { return; }
  let xb = p.xOff + r * p.D;
  var s = 0.0;
  for (var i = lid.x; i < p.D; i = i + 256u) { let v = X[xb + i]; s += v * v; }
  red[lid.x] = s;
  workgroupBarrier();
  for (var w = 128u; w > 0u; w = w >> 1u) { if (lid.x < w) { red[lid.x] += red[lid.x + w]; } workgroupBarrier(); }
  let rstd = inverseSqrt(red[0] / f32(p.D) + p.eps);
  if (lid.x == 0u) { R[r] = rstd; }
  let yb = p.yOff + r * p.D;
  for (var i = lid.x; i < p.D; i = i + 256u) {
    var w = 1.0;
    if (p.hasW == 1u) { w = load_W(i); if (p.plusOne == 1u) { w = w + 1.0; } }
    Y[yb + i] = X[xb + i] * rstd * w;
  }
}`;

// dx = rstd * (w*dy) - x * rstd^3 * mean(x*w*dy)
export const RMSNORM_BWD = (wdtype) => `
struct P { rows: u32, D: u32, xOff: u32, dxOff: u32, acc: u32, hasW: u32, plusOne: u32, pad: u32 };
@group(0) @binding(0) var<storage, read> X: array<f32>;
${loader('W', wdtype, 1, 9)}
@group(0) @binding(2) var<storage, read> DY: array<f32>;
@group(0) @binding(3) var<storage, read> R: array<f32>;
@group(0) @binding(4) var<storage, read_write> DX: array<f32>;
@group(0) @binding(5) var<uniform> p: P;
var<workgroup> red: array<f32, 256>;
@compute @workgroup_size(256)
fn main(@builtin(workgroup_id) wg: vec3<u32>, @builtin(num_workgroups) nw: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>) {
  let r = wg.x + wg.y * nw.x;
  if (r >= p.rows) { return; }
  let xb = p.xOff + r * p.D;
  let db = r * p.D;
  let rstd = R[r];
  var s = 0.0;
  for (var i = lid.x; i < p.D; i = i + 256u) {
    var w = 1.0; if (p.hasW == 1u) { w = load_W(i); if (p.plusOne == 1u) { w = w + 1.0; } }
    s += X[xb + i] * w * DY[db + i];
  }
  red[lid.x] = s;
  workgroupBarrier();
  for (var w = 128u; w > 0u; w = w >> 1u) { if (lid.x < w) { red[lid.x] += red[lid.x + w]; } workgroupBarrier(); }
  let c = red[0] / f32(p.D) * rstd * rstd * rstd;
  let ob = p.dxOff + r * p.D;
  for (var i = lid.x; i < p.D; i = i + 256u) {
    var w = 1.0; if (p.hasW == 1u) { w = load_W(i); if (p.plusOne == 1u) { w = w + 1.0; } }
    let v = rstd * w * DY[db + i] - X[xb + i] * c;
    if (p.acc == 1u) { DX[ob + i] = DX[ob + i] + v; } else { DX[ob + i] = v; }
  }
}`;

// dW[c] += sum_r dY[r][c] * X[r][c] * rstd[r]  (norm weight gradient, full fine-tuning)
export const RMSNORM_DW = `
struct P { rows: u32, D: u32, xOff: u32, pad: u32 };
@group(0) @binding(0) var<storage, read> X: array<f32>;
@group(0) @binding(1) var<storage, read> DY: array<f32>;
@group(0) @binding(2) var<storage, read> R: array<f32>;
@group(0) @binding(3) var<storage, read_write> DW: array<f32>;
@group(0) @binding(4) var<uniform> p: P;
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let c = gid.x;
  if (c >= p.D) { return; }
  var s = 0.0;
  for (var r = 0u; r < p.rows; r = r + 1u) { s += DY[r * p.D + c] * X[p.xOff + r * p.D + c] * R[r]; }
  DW[c] = DW[c] + s;
}`;

// ---------- RoPE (rotate-half / NeoX layout), in place on [T, H, d] ----------
export const ROPE = `
struct P { T: u32, H: u32, d: u32, pos0: u32, sign: f32, off: u32, rowStride: u32, pad: u32 };
@group(0) @binding(0) var<storage, read_write> X: array<f32>;
@group(0) @binding(1) var<storage, read> INV: array<f32>;
@group(0) @binding(2) var<uniform> p: P;
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) nw: vec3<u32>) {
  let half = p.d / 2u;
  let idx = gid.x + gid.y * nw.x * 256u;
  if (idx >= p.T * p.H * half) { return; }
  let i = idx % half;
  let h = (idx / half) % p.H;
  let t = idx / (half * p.H);
  let ang = f32(p.pos0 + t) * INV[i];
  let c = cos(ang); let s = sin(ang) * p.sign;
  let base = p.off + t * p.rowStride + h * p.d;
  let x1 = X[base + i]; let x2 = X[base + i + half];
  X[base + i] = x1 * c - x2 * s;
  X[base + i + half] = x2 * c + x1 * s;
}`;

// ---------- causal softmax over S[H][Tq][Tk] rows (scale applied), with key offset for KV cache ----------
export const SOFTMAX_FWD = `
struct P { rows: u32, Tq: u32, Tk: u32, pos0: u32, scale: f32, causal: u32, pad0: u32, pad1: u32 };
@group(0) @binding(0) var<storage, read_write> S: array<f32>;
@group(0) @binding(1) var<uniform> p: P;
var<workgroup> red: array<f32, 256>;
@compute @workgroup_size(256)
fn main(@builtin(workgroup_id) wg: vec3<u32>, @builtin(num_workgroups) nw: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>) {
  let r = wg.x + wg.y * nw.x;
  if (r >= p.rows) { return; }
  let q = r % p.Tq;
  var lim = p.Tk;
  if (p.causal == 1u) { lim = min(p.Tk, p.pos0 + q + 1u); }
  let b = r * p.Tk;
  var m = -3.4e38;
  for (var j = lid.x; j < lim; j = j + 256u) { m = max(m, S[b + j] * p.scale); }
  red[lid.x] = m;
  workgroupBarrier();
  for (var w = 128u; w > 0u; w = w >> 1u) { if (lid.x < w) { red[lid.x] = max(red[lid.x], red[lid.x + w]); } workgroupBarrier(); }
  let mx = red[0];
  workgroupBarrier();
  var s = 0.0;
  for (var j = lid.x; j < lim; j = j + 256u) { s += exp(S[b + j] * p.scale - mx); }
  red[lid.x] = s;
  workgroupBarrier();
  for (var w = 128u; w > 0u; w = w >> 1u) { if (lid.x < w) { red[lid.x] += red[lid.x + w]; } workgroupBarrier(); }
  let inv = 1.0 / red[0];
  for (var j = lid.x; j < p.Tk; j = j + 256u) {
    if (j < lim) { S[b + j] = exp(S[b + j] * p.scale - mx) * inv; } else { S[b + j] = 0.0; }
  }
}`;

// dS = P * (dP - sum(dP*P))  (in place into dP), scale folded later
export const SOFTMAX_BWD = `
struct P { rows: u32, Tk: u32, scale: f32, pad: u32 };
@group(0) @binding(0) var<storage, read> Pm: array<f32>;
@group(0) @binding(1) var<storage, read_write> dP: array<f32>;
@group(0) @binding(2) var<uniform> p: P;
var<workgroup> red: array<f32, 256>;
@compute @workgroup_size(256)
fn main(@builtin(workgroup_id) wg: vec3<u32>, @builtin(num_workgroups) nw: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>) {
  let r = wg.x + wg.y * nw.x;
  if (r >= p.rows) { return; }
  let b = r * p.Tk;
  var s = 0.0;
  for (var j = lid.x; j < p.Tk; j = j + 256u) { s += dP[b + j] * Pm[b + j]; }
  red[lid.x] = s;
  workgroupBarrier();
  for (var w = 128u; w > 0u; w = w >> 1u) { if (lid.x < w) { red[lid.x] += red[lid.x + w]; } workgroupBarrier(); }
  let dot = red[0];
  for (var j = lid.x; j < p.Tk; j = j + 256u) { dP[b + j] = Pm[b + j] * (dP[b + j] - dot) * p.scale; }
}`;

// ---------- embedding gather: out[t] = E[ids[t] - rowStart] for ids in [rowStart, rowStart+rows) ----------
export const EMBED = (edtype) => `
struct P { T: u32, D: u32, rowStart: u32, rows: u32, scale: f32, pad0: u32, pad1: u32, pad2: u32 };
@group(0) @binding(0) var<storage, read> IDS: array<u32>;
${loader('E', edtype, 1, 9)}
@group(0) @binding(2) var<storage, read_write> O: array<f32>;
@group(0) @binding(3) var<uniform> p: P;
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) nw: vec3<u32>) {
  let idx = gid.x + gid.y * nw.x * 256u;
  if (idx >= p.T * p.D) { return; }
  let t = idx / p.D; let c = idx % p.D;
  let id = IDS[t];
  if (id < p.rowStart || id >= p.rowStart + p.rows) { return; }
  O[idx] = load_E((id - p.rowStart) * p.D + c) * p.scale;
}`;

// Embedding gradient: dE[id] += dX[t] (atomic float add via CAS on u32 bits).
export const EMBED_BWD = `
struct P { T: u32, D: u32, rowStart: u32, rows: u32 };
@group(0) @binding(0) var<storage, read> IDS: array<u32>;
@group(0) @binding(1) var<storage, read> DX: array<f32>;
@group(0) @binding(2) var<storage, read_write> DE: array<atomic<u32>>;
@group(0) @binding(3) var<uniform> p: P;
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) nw: vec3<u32>) {
  let idx = gid.x + gid.y * nw.x * 256u;
  if (idx >= p.T * p.D) { return; }
  let t = idx / p.D; let c = idx % p.D;
  let id = IDS[t];
  if (id < p.rowStart || id >= p.rowStart + p.rows) { return; }
  let a = (id - p.rowStart) * p.D + c;
  let v = DX[idx];
  var old = atomicLoad(&DE[a]);
  loop {
    let nv = bitcast<u32>(bitcast<f32>(old) + v);
    let r = atomicCompareExchangeWeak(&DE[a], old, nv);
    if (r.exchanged) { break; }
    old = r.old_value;
  }
}`;

// ---------- cross entropy over a chunk of logit rows [R][V] ----------
// out: LP[r] = log p(label) (0 if ignored); the logits row becomes coef[r] * (softmax - onehot) (zeros when coef is 0).
export const XENT = `
struct P { R: u32, V: u32, pad0: u32, pad1: u32 };
@group(0) @binding(0) var<storage, read_write> L: array<f32>;
@group(0) @binding(1) var<storage, read> LAB: array<i32>;
@group(0) @binding(2) var<storage, read> COEF: array<f32>;
@group(0) @binding(3) var<storage, read_write> LP: array<f32>;
@group(0) @binding(4) var<uniform> p: P;
var<workgroup> red: array<f32, 256>;
@compute @workgroup_size(256)
fn main(@builtin(workgroup_id) wg: vec3<u32>, @builtin(num_workgroups) nw: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>) {
  let r = wg.x + wg.y * nw.x;
  if (r >= p.R) { return; }
  let b = r * p.V;
  var m = -3.4e38;
  for (var j = lid.x; j < p.V; j = j + 256u) { m = max(m, L[b + j]); }
  red[lid.x] = m;
  workgroupBarrier();
  for (var w = 128u; w > 0u; w = w >> 1u) { if (lid.x < w) { red[lid.x] = max(red[lid.x], red[lid.x + w]); } workgroupBarrier(); }
  let mx = red[0];
  workgroupBarrier();
  var s = 0.0;
  for (var j = lid.x; j < p.V; j = j + 256u) { s += exp(L[b + j] - mx); }
  red[lid.x] = s;
  workgroupBarrier();
  for (var w = 128u; w > 0u; w = w >> 1u) { if (lid.x < w) { red[lid.x] += red[lid.x + w]; } workgroupBarrier(); }
  let lse = mx + log(red[0]);
  let lab = LAB[r];
  if (lid.x == 0u) { if (lab >= 0) { LP[r] = L[b + u32(lab)] - lse; } else { LP[r] = 0.0; } }
  workgroupBarrier();
  let c = COEF[r];
  for (var j = lid.x; j < p.V; j = j + 256u) {
    var g = exp(L[b + j] - lse);
    if (i32(j) == lab) { g = g - 1.0; }
    L[b + j] = c * g;
  }
}`;

// ---------- AdamW ----------
export const ADAMW = `
struct P { n: u32, step: u32, lr: f32, b1: f32, b2: f32, eps: f32, wd: f32, gscale: f32 };
@group(0) @binding(0) var<storage, read_write> W: array<f32>;
@group(0) @binding(1) var<storage, read_write> G: array<f32>;
@group(0) @binding(2) var<storage, read_write> M: array<f32>;
@group(0) @binding(3) var<storage, read_write> V: array<f32>;
@group(0) @binding(4) var<uniform> p: P;
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) nw: vec3<u32>) {
  let i = gid.x + gid.y * nw.x * 256u;
  if (i >= p.n) { return; }
  let g = G[i] * p.gscale;
  let m = p.b1 * M[i] + (1.0 - p.b1) * g;
  let v = p.b2 * V[i] + (1.0 - p.b2) * g * g;
  M[i] = m; V[i] = v;
  let t = f32(p.step);
  let mh = m / (1.0 - pow(p.b1, t));
  let vh = v / (1.0 - pow(p.b2, t));
  W[i] = W[i] - p.lr * (mh / (sqrt(vh) + p.eps) + p.wd * W[i]);
  G[i] = 0.0;
}`;

// Sum of squares, partial per workgroup (for gradient norm and losses).
export const SUMSQ = `
struct P { n: u32, off: u32, pad1: u32, pad2: u32 };
@group(0) @binding(0) var<storage, read> X: array<f32>;
@group(0) @binding(1) var<storage, read_write> O: array<f32>;
@group(0) @binding(2) var<uniform> p: P;
var<workgroup> red: array<f32, 256>;
@compute @workgroup_size(256)
fn main(@builtin(workgroup_id) wgid: vec3<u32>, @builtin(num_workgroups) nw: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>) {
  let wx = wgid.x + wgid.y * nw.x;
  if (wx * 4096u >= p.n) { return; }
  var s = 0.0;
  let start = wx * 4096u;
  for (var i = start + lid.x; i < min(p.n, start + 4096u); i = i + 256u) { let v = X[i]; s += v * v; }
  red[lid.x] = s;
  workgroupBarrier();
  for (var w = 128u; w > 0u; w = w >> 1u) { if (lid.x < w) { red[lid.x] += red[lid.x + w]; } workgroupBarrier(); }
  if (lid.x == 0u) { O[p.off + wx] = red[0]; }
}`;

// Row-broadcast bias add: X[t][c] += b[c]
export const BIAS_ADD = (bdtype) => `
struct P { T: u32, D: u32, off: u32, ld: u32 };
@group(0) @binding(0) var<storage, read_write> X: array<f32>;
${loader('Bb', bdtype, 1, 9)}
@group(0) @binding(2) var<uniform> p: P;
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) nw: vec3<u32>) {
  let idx = gid.x + gid.y * nw.x * 256u;
  if (idx >= p.T * p.D) { return; }
  let t = idx / p.D; let c = idx % p.D;
  X[p.off + t * p.ld + c] += load_Bb(c);
}`;

// Column sums (bias gradient): db[c] += sum_t dY[t][c]
export const COLSUM = `
struct P { T: u32, D: u32, pad0: u32, pad1: u32 };
@group(0) @binding(0) var<storage, read> DY: array<f32>;
@group(0) @binding(1) var<storage, read_write> DB: array<f32>;
@group(0) @binding(2) var<uniform> p: P;
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let c = gid.x;
  if (c >= p.D) { return; }
  var s = 0.0;
  for (var t = 0u; t < p.T; t = t + 1u) { s += DY[t * p.D + c]; }
  DB[c] = DB[c] + s;
}`;

// Copy rows with strides (used for KV cache writes and gathering last rows).
export const COPY2D = `
struct P { rows: u32, cols: u32, srcOff: u32, srcLd: u32, dstOff: u32, dstLd: u32, pad0: u32, pad1: u32 };
@group(0) @binding(0) var<storage, read> S: array<f32>;
@group(0) @binding(1) var<storage, read_write> D: array<f32>;
@group(0) @binding(2) var<uniform> p: P;
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) nw: vec3<u32>) {
  let idx = gid.x + gid.y * nw.x * 256u;
  if (idx >= p.rows * p.cols) { return; }
  let r = idx / p.cols; let c = idx % p.cols;
  D[p.dstOff + r * p.dstLd + c] = S[p.srcOff + r * p.srcLd + c];
}`;
