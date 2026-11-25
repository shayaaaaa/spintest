// ffmpeg.wasm core (single-threaded build) loaded from the Hub; runs one command at a time.
let core = null, base = null, logs = null;

async function load(b) {
  if (core && base === b) return core;
  base = b;
  const { default: createFFmpegCore } = await import(b + 'ffmpeg-core.js');
  core = await createFFmpegCore({ mainScriptUrlOrBlob: b + 'ffmpeg-core.js', locateFile: (p) => b + p, print: (s) => logs?.(s), printErr: (s) => logs?.(s) });
  core.setLogger?.(({ message }) => logs?.(message));
  return core;
}

self.onmessage = async (e) => {
  const { id, type, base: b, args, files, outputs } = e.data;
  try {
    if (type !== 'exec') return;
    const c = await load(b);
    logs = (s) => self.postMessage({ id, log: s });
    for (const [name, data] of files) c.FS.writeFile(name, new Uint8Array(data));
    c.setTimeout?.(-1);
    const code = c.exec(...args);
    const outs = [];
    for (const o of outputs) { try { const d = c.FS.readFile(o); outs.push([o, d.buffer]); c.FS.unlink(o); } catch {} }
    for (const [name] of files) { try { c.FS.unlink(name); } catch {} }
    c.reset?.();
    self.postMessage({ id, code, outputs: outs }, outs.map(o => o[1]));
  } catch (err) {
    self.postMessage({ id, error: String(err?.message || err) });
  }
};
