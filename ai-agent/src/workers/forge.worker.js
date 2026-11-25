// Forge worker: runs the WebGPU training/inference engine off the main thread. Protocol:
//   in:  {type:'rpc', id, method, args} | {type:'call-result', id, result|error}
//   out: {type:'ready', gpu} | {type:'rpc-result', id, result|error} | {type:'event', event} | {type:'call', id, name, args}
import { ForgeHost } from '../forge/host.js';

const waits = new Map();
let seq = 0;
const call = (name, args) => new Promise((resolve, reject) => { const id = ++seq; waits.set(id, { resolve, reject }); postMessage({ type: 'call', id, name, args }); });
const host = new ForgeHost({ emit: (event) => postMessage({ type: 'event', event }), call });

self.onmessage = async (e) => {
  const d = e.data;
  if (d.type === 'call-result') { const w = waits.get(d.id); if (w) { waits.delete(d.id); d.error ? w.reject(new Error(d.error)) : w.resolve(d.result); } return; }
  if (d.type !== 'rpc') return;
  try {
    if (typeof host[d.method] !== 'function') throw new Error('Unknown Forge method ' + d.method);
    const result = await host[d.method](...(d.args || []));
    postMessage({ type: 'rpc-result', id: d.id, result });
  } catch (err) {
    postMessage({ type: 'rpc-result', id: d.id, error: String(err?.message || err), name: err?.name });
  }
};
postMessage({ type: 'ready', gpu: !!self.navigator?.gpu });
