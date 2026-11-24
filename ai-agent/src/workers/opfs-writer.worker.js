// OPFS writer for browsers without FileSystemFileHandle.createWritable (uses sync access handles, worker-only API).
const streams = new Map();
let seq = 0;

async function handleFor(rootName, path) {
  let d = await (await navigator.storage.getDirectory()).getDirectoryHandle(rootName, { create: true });
  const parts = path.split('/').filter(Boolean);
  const name = parts.pop();
  for (const p of parts) d = await d.getDirectoryHandle(p, { create: true });
  return d.getFileHandle(name, { create: true });
}

self.onmessage = async (e) => {
  const { id, op, root, path } = e.data;
  try {
    let result = null;
    if (op === 'write') {
      const ah = await (await handleFor(root, path)).createSyncAccessHandle();
      try {
        const bytes = new Uint8Array(e.data.data);
        if (e.data.append) ah.write(bytes, { at: ah.getSize() });
        else { ah.truncate(0); ah.write(bytes, { at: 0 }); }
        ah.flush();
      } finally { ah.close(); }
    } else if (op === 'open') {
      const ah = await (await handleFor(root, path)).createSyncAccessHandle();
      if (!e.data.offset) ah.truncate(0);
      const sid = ++seq;
      streams.set(sid, { ah, pos: e.data.offset || 0 });
      result = sid;
    } else if (op === 'chunk') {
      const s = streams.get(e.data.sid);
      const bytes = new Uint8Array(e.data.data);
      s.ah.write(bytes, { at: s.pos });
      s.pos += bytes.byteLength;
    } else if (op === 'close') {
      const s = streams.get(e.data.sid);
      if (s) { s.ah.flush(); s.ah.close(); streams.delete(e.data.sid); }
    }
    self.postMessage({ id, result });
  } catch (err) {
    self.postMessage({ id, error: String(err?.message || err) });
  }
};
