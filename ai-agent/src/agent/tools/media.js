// Media tools: ImageEdit (canvas, instant) and Media (ffmpeg in WebAssembly for audio/video, downloaded on first use).
import * as vfs from '../../core/vfs.js';
import { extOf, mimeOf } from '../../core/util.js';

export const ImageEdit = {
  name: 'ImageEdit',
  description: 'Edit an image: resize (width/height), crop {x,y,w,h}, rotate (90/180/270), flip, grayscale, adjust quality, or convert format (png/jpg/webp). Saves to output (or overwrites input).',
  input_schema: { type: 'object', properties: {
    input: { type: 'string' }, output: { type: 'string' }, width: { type: 'number' }, height: { type: 'number' },
    crop: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' }, w: { type: 'number' }, h: { type: 'number' } } },
    rotate: { type: 'number' }, flip: { type: 'string', enum: ['horizontal', 'vertical'] }, grayscale: { type: 'boolean' }, quality: { type: 'number' },
  }, required: ['input'] },
  kind: 'edit',
  key: (i) => i.output || i.input,
  summary: (i) => `${i.input}${i.output ? ' → ' + i.output : ''}`,
  async run(i, ctx) {
    const src = vfs.normalize(i.input, ctx.cwd);
    const out = vfs.normalize(i.output || i.input, ctx.cwd);
    const bmp = await createImageBitmap(await vfs.getFile(src));
    let sx = 0, sy = 0, sw = bmp.width, sh = bmp.height;
    if (i.crop) { sx = i.crop.x || 0; sy = i.crop.y || 0; sw = i.crop.w || sw - sx; sh = i.crop.h || sh - sy; }
    let w = i.width || (i.height ? Math.round(sw * i.height / sh) : sw), h = i.height || (i.width ? Math.round(sh * i.width / sw) : sh);
    const rot = ((i.rotate || 0) % 360 + 360) % 360;
    const cw = rot === 90 || rot === 270 ? h : w, ch = rot === 90 || rot === 270 ? w : h;
    const c = new OffscreenCanvas(cw, ch);
    const g = c.getContext('2d');
    g.translate(cw / 2, ch / 2);
    g.rotate(rot * Math.PI / 180);
    if (i.flip === 'horizontal') g.scale(-1, 1);
    if (i.flip === 'vertical') g.scale(1, -1);
    if (i.grayscale) g.filter = 'grayscale(1)';
    g.drawImage(bmp, sx, sy, sw, sh, -w / 2, -h / 2, w, h);
    const type = mimeOf(out).startsWith('image/') ? mimeOf(out) : 'image/png';
    const blob = await c.convertToBlob({ type, quality: (i.quality ?? 90) / 100 });
    await vfs.write(out, blob);
    return { content: `Saved ${out} (${cw}×${ch}, ${Math.round(blob.size / 1024)} KB)`, display: { kind: 'image', path: out } };
  },
};

// ---------- ffmpeg ----------
const FF_VER = '0.12.10';
const FF_DIR = '/runtimes/ffmpeg';
let ffWorker = null, ffSeq = 0;
const ffWaits = new Map();

async function ensureFfmpeg(onProgress) {
  const files = ['ffmpeg-core.js', 'ffmpeg-core.wasm'];
  for (const f of files) {
    if (await vfs.exists(`${FF_DIR}/${f}`)) continue;
    if (!navigator.onLine) throw new Error('ffmpeg needs a one-time download (~32 MB). Connect to the internet and try again.');
    onProgress?.(`Downloading ffmpeg (${f})…`);
    const r = await fetch(`https://cdn.jsdelivr.net/npm/@ffmpeg/core@${FF_VER}/dist/esm/${f}`);
    if (!r.ok) throw new Error('ffmpeg download failed: ' + r.status);
    await vfs.write(`${FF_DIR}/${f}`, await r.blob());
  }
}

function ffCall(msg, transfer) {
  if (!ffWorker) {
    ffWorker = new Worker(new URL('../../workers/media.worker.js', import.meta.url), { type: 'module' });
    ffWorker.onmessage = (e) => { const w = ffWaits.get(e.data.id); if (!w) return; if (e.data.log != null) { w.onLog?.(e.data.log); return; } ffWaits.delete(e.data.id); w.resolve(e.data); };
  }
  const id = ++ffSeq;
  return new Promise((resolve) => { ffWaits.set(id, { resolve, onLog: msg.onLog }); const { onLog, ...m } = msg; ffWorker.postMessage({ id, ...m }, transfer); });
}

export async function runFfmpeg(args, { inputs = [], outputs = [], cwd = '/workspace', onLog, onProgress } = {}) {
  await ensureFfmpeg(onProgress);
  const base = new URL('hub/runtimes/ffmpeg/', document.baseURI).href;
  const files = [];
  for (const p of inputs) { const a = vfs.normalize(p, cwd); files.push([vfs.basename(a), await (await vfs.getFile(a)).arrayBuffer()]); }
  const r = await ffCall({ type: 'exec', base, args, files, outputs: outputs.map(o => vfs.basename(o)), onLog }, files.map(f => f[1]));
  if (r.error) throw new Error(r.error);
  for (const [name, data] of r.outputs || []) { const target = outputs.find(o => vfs.basename(o) === name); await vfs.write(vfs.normalize(target, cwd), new Uint8Array(data)); }
  return r;
}

export const Media = {
  name: 'Media',
  description: 'Process audio and video with ffmpeg (runs on the phone; first use downloads ~32 MB). Give ffmpeg arguments using bare file names, plus the input and output paths. Examples: convert mov→mp4, trim (-ss 5 -t 10), extract audio (-vn), make a GIF, change resolution, compress.',
  input_schema: { type: 'object', properties: { args: { type: 'array', items: { type: 'string' }, description: 'ffmpeg arguments, e.g. ["-i","in.mov","-vf","scale=720:-2","out.mp4"]' }, inputs: { type: 'array', items: { type: 'string' } }, outputs: { type: 'array', items: { type: 'string' } } }, required: ['args', 'inputs', 'outputs'] },
  kind: 'exec',
  key: () => 'ffmpeg',
  summary: (i) => 'ffmpeg ' + i.args.join(' ').slice(0, 80),
  async preview(i) { return { type: 'command', command: 'ffmpeg ' + i.args.join(' ') }; },
  async run(i, ctx) {
    let log = '';
    const r = await runFfmpeg(i.args, { inputs: i.inputs, outputs: i.outputs, cwd: ctx.cwd, onLog: (l) => { log += l + '\n'; ctx.onProgress?.(l); }, onProgress: (p) => ctx.onProgress?.(p) });
    return { content: `ffmpeg finished (exit ${r.code}). Outputs: ${i.outputs.join(', ')}\n${log.split('\n').slice(-12).join('\n')}`, isError: r.code !== 0, display: { kind: 'shell', output: log.split('\n').slice(-30).join('\n'), code: r.code } };
  },
};

export const mediaTools = [ImageEdit, Media];
