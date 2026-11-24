// safetensors read/write + float conversions (bf16/f16/f32) + NF4 quantization.
import { NF4 } from './kernels.js';

export async function readHeader(file) {
  const head = new DataView(await file.slice(0, 8).arrayBuffer());
  const n = Number(head.getBigUint64(0, true));
  const json = JSON.parse(await file.slice(8, 8 + n).text());
  const meta = json.__metadata__ || {};
  delete json.__metadata__;
  return { tensors: json, dataStart: 8 + n, meta };
}

const hasF16Array = typeof Float16Array !== 'undefined';

export function bf16ToF32(u16) {
  const out = new Float32Array(u16.length);
  const o32 = new Uint32Array(out.buffer);
  for (let i = 0; i < u16.length; i++) o32[i] = u16[i] << 16;
  return out;
}
const f16tab = (() => { const t = new Float32Array(65536); for (let h = 0; h < 65536; h++) { const s = h & 0x8000 ? -1 : 1, e = (h >> 10) & 0x1f, m = h & 0x3ff; t[h] = e === 0 ? s * m * 2 ** -24 : e === 31 ? (m ? NaN : s * Infinity) : s * (1 + m / 1024) * 2 ** (e - 15); } return t; })();
export function f16ToF32(u16) {
  if (hasF16Array) return Float32Array.from(new Float16Array(u16.buffer, u16.byteOffset, u16.length));
  const out = new Float32Array(u16.length);
  for (let i = 0; i < u16.length; i++) out[i] = f16tab[u16[i]];
  return out;
}
const cvtBuf = new Float32Array(1), cvtU = new Uint32Array(cvtBuf.buffer);
export function f32ToF16Bits(x) {
  cvtBuf[0] = x; const u = cvtU[0];
  const s = (u >>> 16) & 0x8000; let e = ((u >>> 23) & 0xff) - 112; let m = u & 0x7fffff;
  if (e <= 0) { if (e < -10) return s; m = (m | 0x800000) >> (1 - e); return s | ((m + 0x1000) >> 13); }
  if (e >= 31) return s | 0x7c00;
  const h = s | (e << 10) | (m >> 13);
  return (m & 0x1fff) > 0x1000 || ((m & 0x1fff) === 0x1000 && (h & 1)) ? h + 1 : h;
}
export function f32ToF16(arr) {
  if (hasF16Array) return new Uint16Array(new Float16Array(arr).buffer);
  const out = new Uint16Array(arr.length);
  for (let i = 0; i < arr.length; i++) out[i] = f32ToF16Bits(arr[i]);
  return out;
}
export function f32ToBf16(arr) {
  const u = new Uint32Array(arr.buffer, arr.byteOffset, arr.length);
  const out = new Uint16Array(arr.length);
  for (let i = 0; i < arr.length; i++) { const x = u[i]; out[i] = (x + 0x7fff + ((x >> 16) & 1)) >>> 16; }
  return out;
}

// Reads one tensor as Float32Array.
export async function readTensor(file, info, dataStart) {
  const [s, e] = info.data_offsets;
  const buf = await file.slice(dataStart + s, dataStart + e).arrayBuffer();
  if (info.dtype === 'F32') return new Float32Array(buf);
  if (info.dtype === 'BF16') return bf16ToF32(new Uint16Array(buf));
  if (info.dtype === 'F16') return f16ToF32(new Uint16Array(buf));
  throw new Error(`Unsupported dtype ${info.dtype}`);
}

// NF4 quantization (blocks of 64 along the flat index). Returns {q: Uint32Array (8 codes per u32), scales: Float32Array}.
const nf4Mid = NF4.slice(0, -1).map((v, i) => (v + NF4[i + 1]) / 2);
export function quantNF4(arr) {
  const n = arr.length;
  if (n % 64) throw new Error('NF4 needs a multiple of 64 elements');
  const q = new Uint32Array(n / 8), scales = new Float32Array(n / 64);
  for (let g = 0; g < n / 64; g++) {
    let am = 0; const b = g * 64;
    for (let i = 0; i < 64; i++) { const a = Math.abs(arr[b + i]); if (a > am) am = a; }
    scales[g] = am || 1;
    const inv = 1 / scales[g];
    for (let i = 0; i < 64; i++) {
      const v = arr[b + i] * inv;
      let lo = 0, hi = 15;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (v > nf4Mid[mid]) lo = mid + 1; else hi = mid; }
      const idx = b + i;
      q[idx >> 3] |= lo << ((idx & 7) * 4);
    }
  }
  return { q, scales };
}

// Packs f32 values into f16 pairs (u32 words) for GPU storage.
export function packF16(arr) {
  const h = f32ToF16(arr);
  const out = new Uint32Array(Math.ceil(h.length / 2));
  out.set(new Uint32Array(h.buffer, 0, h.length >> 1));
  if (h.length & 1) out[out.length - 1] = h[h.length - 1];
  return out;
}

// Builds a safetensors file. tensors: [{name, dtype: 'F32'|'F16'|'BF16', shape, data (TypedArray)}]
export function encodeSafetensors(tensors, metadata = {}) {
  const header = { __metadata__: Object.fromEntries(Object.entries(metadata).map(([k, v]) => [k, String(v)])) };
  let off = 0;
  for (const t of tensors) {
    const bytes = t.data.byteLength;
    header[t.name] = { dtype: t.dtype, shape: t.shape, data_offsets: [off, off + bytes] };
    off += bytes;
  }
  let hjson = JSON.stringify(header);
  while ((8 + hjson.length) % 8) hjson += ' ';
  const hb = new TextEncoder().encode(hjson);
  const len = new DataView(new ArrayBuffer(8)); len.setBigUint64(0, BigInt(hb.length), true);
  return new Blob([len.buffer, hb, ...tensors.map(t => t.data)], { type: 'application/octet-stream' });
}
