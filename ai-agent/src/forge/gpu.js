// Forge GPU runtime: device, buffers, cached compute pipelines, uniform ring, batched command encoding, readback.
export class GPU {
  static async create() {
    if (!navigator.gpu) throw new Error('WebGPU is not available on this device/browser.');
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) throw new Error('No WebGPU adapter found.');
    const L = adapter.limits;
    const want = ['maxBufferSize', 'maxStorageBufferBindingSize', 'maxComputeWorkgroupStorageSize', 'maxComputeInvocationsPerWorkgroup', 'maxStorageBuffersPerShaderStage', 'maxComputeWorkgroupsPerDimension', 'maxComputeWorkgroupSizeX', 'maxComputeWorkgroupSizeY'];
    const requiredLimits = {};
    for (const k of want) if (L[k] != null) requiredLimits[k] = L[k];
    const device = await adapter.requestDevice({ requiredLimits });
    const g = new GPU(device, adapter);
    device.lost.then((info) => { g.lost = info; console.error('WebGPU device lost', info?.message); });
    device.addEventListener?.('uncapturederror', (e) => { g.lastError = e.error?.message; console.error('WebGPU error:', e.error?.message); });
    return g;
  }

  constructor(device, adapter) {
    this.device = device;
    this.adapter = adapter;
    this.limits = device.limits;
    this.maxBinding = device.limits.maxStorageBufferBindingSize;
    this.maxWG = device.limits.maxComputeWorkgroupsPerDimension || 65535;
    this.pipelines = new Map();
    this.enc = null;
    this.pass = null;
    this.dispatches = 0;
    this.ringSize = 1 << 22; // 4 MB of 256-byte uniform slots
    this.ring = device.createBuffer({ size: this.ringSize, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.ringPos = 0;
    this.pool = new Map(); // size -> [buffers]
    this.allocated = 0;
  }

  // ---------- buffers ----------
  buffer(bytes, { label, usage } = {}) {
    const size = Math.max(16, Math.ceil(bytes / 16) * 16);
    if (size > this.limits.maxBufferSize) throw new Error(`Buffer of ${(size / 1e6).toFixed(0)} MB exceeds this GPU's limit (${(this.limits.maxBufferSize / 1e6).toFixed(0)} MB).`);
    const b = this.device.createBuffer({ size, label, usage: usage || (GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST) });
    this.allocated += size;
    b._size = size;
    return b;
  }
  // Temporary buffers are pooled by size and reused.
  temp(bytes) {
    const size = Math.max(16, Math.ceil(bytes / 256) * 256);
    const list = this.pool.get(size);
    if (list?.length) return list.pop();
    const b = this.buffer(size, { label: 'tmp' });
    b._pooled = true;
    return b;
  }
  release(b) {
    if (!b) return;
    if (b._pooled) { if (!this.pool.has(b._size)) this.pool.set(b._size, []); this.pool.get(b._size).push(b); }
    else this.free(b);
  }
  // Destroying a buffer that unsubmitted commands use would invalidate the whole batch, so wait for the next submit.
  free(b) { if (!b) return; this.allocated -= b._size || 0; if (this.enc) (this.deferred ||= []).push(b); else b.destroy(); }
  trimPool() { this.flush(); for (const list of this.pool.values()) for (const b of list) { this.allocated -= b._size; b.destroy(); } this.pool.clear(); }

  upload(buf, data, offset = 0) {
    const bytes = data instanceof ArrayBuffer ? data : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
    // writeBuffer needs a multiple of 4 bytes.
    if (bytes.byteLength % 4) { const pad = new Uint8Array(Math.ceil(bytes.byteLength / 4) * 4); pad.set(new Uint8Array(bytes)); this.device.queue.writeBuffer(buf, offset, pad); }
    else this.device.queue.writeBuffer(buf, offset, bytes);
  }
  fromArray(arr, label) {
    const b = this.buffer(arr.byteLength, { label });
    this.upload(b, arr);
    return b;
  }

  async read(buf, bytes = buf._size, offset = 0) {
    this.flush();
    const size = Math.ceil(bytes / 4) * 4;
    const st = this.device.createBuffer({ size, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const enc = this.device.createCommandEncoder();
    enc.copyBufferToBuffer(buf, offset, st, 0, size);
    this.device.queue.submit([enc.finish()]);
    await st.mapAsync(GPUMapMode.READ);
    const out = st.getMappedRange().slice(0, bytes);
    st.unmap(); st.destroy();
    return out;
  }
  async readF32(buf, n, offset = 0) { return new Float32Array(await this.read(buf, n * 4, offset * 4)); }

  copy(src, dst, bytes, srcOff = 0, dstOff = 0) {
    this.endPass();
    this.encoder().copyBufferToBuffer(src, srcOff, dst, dstOff, Math.ceil(bytes / 4) * 4);
  }

  // ---------- pipelines & dispatch ----------
  pipeline(key, code) {
    let p = this.pipelines.get(key);
    if (!p) {
      const module = this.device.createShaderModule({ code, label: key });
      p = this.device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'main' }, label: key });
      this.pipelines.set(key, p);
    }
    return p;
  }

  encoder() { if (!this.enc) this.enc = this.device.createCommandEncoder(); return this.enc; }
  endPass() { if (this.pass) { this.pass.end(); this.pass = null; } }

  uniform(u32) {
    const bytes = Math.ceil(u32.byteLength / 256) * 256;
    if (this.ringPos + bytes > this.ringSize) { this.flush(); this.ringPos = 0; }
    const off = this.ringPos;
    this.device.queue.writeBuffer(this.ring, off, u32.buffer, u32.byteOffset, u32.byteLength);
    this.ringPos += bytes;
    return { buffer: this.ring, offset: off, size: Math.max(16, Math.ceil(u32.byteLength / 16) * 16) };
  }

  // buffers: array of GPUBuffer bound at 0..n-1, params (Uint32Array) bound at n as a uniform.
  run(key, code, buffers, params, wg) {
    const pipe = this.pipeline(key, code);
    const entries = buffers.map((b, i) => ({ binding: i, resource: { buffer: b } }));
    if (params) { const u = this.uniform(params); entries.push({ binding: buffers.length, resource: { buffer: u.buffer, offset: u.offset, size: u.size } }); }
    const bg = this.device.createBindGroup({ layout: pipe.getBindGroupLayout(0), entries });
    if (!this.pass) this.pass = this.encoder().beginComputePass();
    this.pass.setPipeline(pipe);
    this.pass.setBindGroup(0, bg);
    let [x, y = 1, z = 1] = wg;
    if (x > this.maxWG) { y = Math.ceil(x / this.maxWG) * y; x = this.maxWG; }
    this.pass.dispatchWorkgroups(x, y, z);
    if (++this.dispatches % 512 === 0) this.flush();
  }

  flush() {
    this.endPass();
    if (this.enc) { this.device.queue.submit([this.enc.finish()]); this.enc = null; }
    if (this.deferred?.length) { for (const b of this.deferred) b.destroy(); this.deferred = []; }
  }
  async sync() { this.flush(); await this.device.queue.onSubmittedWorkDone(); }
}

// Packs mixed u32/f32 params into a Uint32Array.
export function params(...vals) {
  const n = Math.max(4, Math.ceil(vals.length / 4) * 4);
  const u = new Uint32Array(n);
  const f = new Float32Array(u.buffer);
  vals.forEach((v, i) => { if (typeof v === 'object' && v && 'f' in v) f[i] = v.f; else u[i] = v >>> 0; });
  return u;
}
export const F = (x) => ({ f: x });
