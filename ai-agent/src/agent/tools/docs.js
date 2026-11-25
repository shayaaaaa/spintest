// Document tool: create/read .docx .xlsx .pptx .pdf (+ csv/md/html), and ViewImage for screenshots/photos.
import * as vfs from '../../core/vfs.js';
import { extOf, clip, mimeOf } from '../../core/util.js';
import { blobToBase64 } from '../../models/content.js';

const office = () => import('../../../vendor/office.mjs');
const md = () => import('../../../vendor/markdown.mjs');

// ---------- markdown → structured blocks ----------
async function mdBlocks(text) {
  const { Marked } = await md();
  const toks = new Marked().lexer(String(text || ''));
  const inline = (tokens) => {
    const runs = [];
    const walk = (ts, st = {}) => {
      for (const t of ts || []) {
        if (t.type === 'strong') walk(t.tokens, { ...st, bold: true });
        else if (t.type === 'em') walk(t.tokens, { ...st, italic: true });
        else if (t.type === 'codespan') runs.push({ text: t.text, ...st, code: true });
        else if (t.type === 'link') walk(t.tokens, { ...st, link: t.href });
        else if (t.type === 'br') runs.push({ text: '\n', ...st });
        else if (t.tokens) walk(t.tokens, st);
        else runs.push({ text: (t.text ?? t.raw ?? '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'"), ...st });
      }
    };
    walk(tokens);
    return runs;
  };
  const out = [];
  for (const t of toks) {
    if (t.type === 'heading') out.push({ type: 'h', level: t.depth, runs: inline(t.tokens) });
    else if (t.type === 'paragraph') out.push({ type: 'p', runs: inline(t.tokens) });
    else if (t.type === 'list') t.items.forEach((it, i) => out.push({ type: 'li', ordered: t.ordered, n: (t.start || 1) + i, runs: inline(it.tokens?.flatMap(x => x.tokens || [x])) }));
    else if (t.type === 'code') out.push({ type: 'code', text: t.text });
    else if (t.type === 'table') out.push({ type: 'table', header: t.header.map(h => h.text), rows: t.rows.map(r => r.map(c => c.text)) });
    else if (t.type === 'blockquote') out.push({ type: 'quote', runs: inline(t.tokens?.flatMap(x => x.tokens || [x])) });
    else if (t.type === 'hr') out.push({ type: 'hr' });
  }
  return out;
}

async function makeDocx(text, title) {
  const { docx } = await office();
  const { Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell, WidthType, ExternalHyperlink } = docx;
  const runsOf = (runs) => runs.map(r => r.link ? new ExternalHyperlink({ link: r.link, children: [new TextRun({ text: r.text, style: 'Hyperlink' })] }) : new TextRun({ text: r.text, bold: r.bold, italics: r.italic, font: r.code ? 'Courier New' : undefined }));
  const H = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3, HeadingLevel.HEADING_4, HeadingLevel.HEADING_5, HeadingLevel.HEADING_6];
  const children = [];
  for (const b of await mdBlocks(text)) {
    if (b.type === 'h') children.push(new Paragraph({ heading: H[b.level - 1], children: runsOf(b.runs) }));
    else if (b.type === 'p') children.push(new Paragraph({ children: runsOf(b.runs), spacing: { after: 120 } }));
    else if (b.type === 'li') children.push(new Paragraph({ children: runsOf(b.ordered ? [{ text: `${b.n}. ` }, ...b.runs] : b.runs), bullet: b.ordered ? undefined : { level: 0 }, indent: b.ordered ? { left: 360 } : undefined }));
    else if (b.type === 'code') b.text.split('\n').forEach(l => children.push(new Paragraph({ children: [new TextRun({ text: l || ' ', font: 'Courier New', size: 18 })] })));
    else if (b.type === 'quote') children.push(new Paragraph({ children: runsOf(b.runs), indent: { left: 540 }, italics: true }));
    else if (b.type === 'hr') children.push(new Paragraph({ border: { bottom: { color: 'AAAAAA', space: 1, style: 'single', size: 6 } }, children: [] }));
    else if (b.type === 'table') children.push(new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: [b.header, ...b.rows].map((r, i) => new TableRow({ children: r.map(c => new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: String(c), bold: i === 0 })] })] })) })) }));
  }
  const doc = new Document({ title: title || 'Document', creator: 'Ai Agent', styles: { default: { document: { run: { font: 'Calibri', size: 22 } } } }, sections: [{ children }] });
  return Packer.toBlob(doc);
}

async function makePdf(text, title) {
  const { PDFLib } = await office();
  const { PDFDocument, StandardFonts, rgb } = PDFLib;
  const pdf = await PDFDocument.create();
  pdf.setTitle(title || 'Document'); pdf.setCreator('Ai Agent');
  const fonts = { r: await pdf.embedFont(StandardFonts.Helvetica), b: await pdf.embedFont(StandardFonts.HelveticaBold), i: await pdf.embedFont(StandardFonts.HelveticaOblique), m: await pdf.embedFont(StandardFonts.Courier) };
  const W = 595, H = 842, M = 56, maxW = W - 2 * M;
  let page = pdf.addPage([W, H]), y = H - M;
  const safe = (s) => s.replace(/[^\x09\x0A\x0D\x20-\x7E\xA0-\xFF]/g, (c) => ({ '‘': "'", '’': "'", '“': '"', '”': '"', '—': '-', '–': '-', '…': '...', '•': '-' }[c] || '?'));
  const newPage = () => { page = pdf.addPage([W, H]); y = H - M; };
  const line = (words, size, indent = 0) => {
    // words: [{text, font}] -> wraps
    let x = M + indent; const lh = size * 1.4;
    if (y - lh < M) newPage();
    for (const w of words) {
      const f = w.font; const t = safe(w.text);
      const width = f.widthOfTextAtSize(t, size);
      if (x + width > M + maxW && x > M + indent) { y -= lh; x = M + indent; if (y < M) newPage(); }
      page.drawText(t, { x, y: y - size, size, font: f, color: rgb(0.1, 0.1, 0.12) });
      x += width;
    }
    y -= lh;
  };
  const words = (runs) => runs.flatMap(r => r.text.split(/(\s+)/).filter(Boolean).map(t => ({ text: t, font: r.code ? fonts.m : r.bold ? fonts.b : r.italic ? fonts.i : fonts.r })));
  for (const b of await mdBlocks(text)) {
    if (b.type === 'h') { y -= 6; line(words(b.runs).map(w => ({ ...w, font: fonts.b })), [20, 16, 14, 12, 11, 11][b.level - 1]); y -= 2; }
    else if (b.type === 'p') { line(words(b.runs), 11); y -= 5; }
    else if (b.type === 'li') line([{ text: b.ordered ? `${b.n}. ` : '- ', font: fonts.r }, ...words(b.runs)], 11, 14);
    else if (b.type === 'code') { for (const l of b.text.split('\n')) line([{ text: l || ' ', font: fonts.m }], 9.5, 10); y -= 4; }
    else if (b.type === 'quote') line(words(b.runs).map(w => ({ ...w, font: fonts.i })), 11, 18);
    else if (b.type === 'table') { for (const r of [b.header, ...b.rows]) line([{ text: r.join('  |  '), font: r === b.header ? fonts.b : fonts.r }], 10); y -= 4; }
    else if (b.type === 'hr') { page.drawLine({ start: { x: M, y: y - 4 }, end: { x: W - M, y: y - 4 }, thickness: 0.6, color: rgb(0.7, 0.7, 0.7) }); y -= 12; }
  }
  return new Blob([await pdf.save()], { type: 'application/pdf' });
}

async function makeXlsx(content) {
  const { XLSX } = await office();
  const spec = typeof content === 'string' ? JSON.parse(content) : content;
  const wb = XLSX.utils.book_new();
  for (const sh of spec.sheets || [{ name: 'Sheet1', rows: spec.rows || [] }]) {
    const rows = sh.rows.map(r => r.map(c => typeof c === 'string' && c.startsWith('=') ? { f: c.slice(1) } : c));
    const ws = XLSX.utils.aoa_to_sheet(rows);
    ws['!cols'] = (sh.rows[0] || []).map((_, i) => ({ wch: Math.min(50, Math.max(8, ...sh.rows.map(r => String(r[i] ?? '').length + 2))) }));
    XLSX.utils.book_append_sheet(wb, ws, String(sh.name || 'Sheet').slice(0, 31));
  }
  return new Blob([XLSX.write(wb, { type: 'array', bookType: 'xlsx' })], { type: mimeOf('x.xlsx') });
}

async function makePptx(content, cwd) {
  const { PptxGenJS } = await office();
  const spec = typeof content === 'string' ? JSON.parse(content) : content;
  const p = new PptxGenJS();
  p.layout = 'LAYOUT_WIDE';
  p.title = spec.title || 'Presentation';
  const theme = spec.theme || {};
  const bg = theme.background || 'FFFFFF', fg = theme.text || '1F2937', accent = theme.accent || '5B5CF0';
  for (const s of spec.slides || []) {
    const sl = p.addSlide();
    sl.background = { color: s.background || bg };
    if (s.title) sl.addText(s.title, { x: 0.6, y: 0.4, w: 12, h: 1, fontSize: s.subtitle && !s.bullets ? 40 : 30, bold: true, color: accent, fontFace: 'Helvetica' });
    if (s.subtitle) sl.addText(s.subtitle, { x: 0.6, y: 1.5, w: 12, h: 0.8, fontSize: 20, color: fg });
    if (s.bullets?.length) sl.addText(s.bullets.map(b => ({ text: b, options: { bullet: true, breakLine: true } })), { x: 0.8, y: 1.7, w: s.image ? 6.6 : 11.6, h: 5, fontSize: 20, color: fg, valign: 'top', paraSpaceAfter: 10 });
    if (s.image) { try { const f = await vfs.getFile(vfs.normalize(s.image, cwd)); sl.addImage({ data: `data:${mimeOf(s.image)};base64,${await blobToBase64(f)}`, x: 7.8, y: 1.7, w: 5, h: 4.2, sizing: { type: 'contain', w: 5, h: 4.2 } }); } catch {} }
    if (s.notes) sl.addNotes(s.notes);
  }
  return p.write({ outputType: 'blob' });
}

export async function readDocument(path) {
  const file = await vfs.getFile(path);
  const ext = extOf(path);
  if (ext === 'pdf') { const { readPdfText } = await import('./fs.js'); return readPdfText(file); }
  if (ext === 'docx') { const { mammoth } = await office(); return (await mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() })).value; }
  if (['xlsx', 'xls', 'ods'].includes(ext)) {
    const { XLSX } = await office();
    const wb = XLSX.read(new Uint8Array(await file.arrayBuffer()), { type: 'array' });
    return wb.SheetNames.map(n => `## Sheet: ${n}\n${XLSX.utils.sheet_to_csv(wb.Sheets[n])}`).join('\n\n');
  }
  if (ext === 'pptx') {
    const { JSZip } = await office();
    const z = await JSZip.loadAsync(file);
    const slides = Object.keys(z.files).filter(n => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort((a, b) => Number(a.match(/\d+/g).pop()) - Number(b.match(/\d+/g).pop()));
    const out = [];
    for (const [i, n] of slides.entries()) {
      const xml = await z.file(n).async('string');
      out.push(`## Slide ${i + 1}\n` + [...xml.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map(m => m[1]).join('\n'));
    }
    return out.join('\n\n');
  }
  return file.text();
}

export const Document = {
  name: 'Document',
  description: 'Create or read office documents. create: format docx|pdf (content = markdown), xlsx (content = JSON {"sheets":[{"name","rows":[[...]]}]}, formulas as "=SUM(A1:A3)"), pptx (content = JSON {"title","theme":{"accent":"5B5CF0"},"slides":[{"title","subtitle","bullets":[],"image":"path","notes"}]}), md|html|csv|txt. read: extracts text from pdf, docx, xlsx, pptx.',
  input_schema: { type: 'object', properties: { action: { type: 'string', enum: ['create', 'read'] }, path: { type: 'string' }, format: { type: 'string', enum: ['docx', 'pdf', 'xlsx', 'pptx', 'md', 'html', 'csv', 'txt'] }, content: { type: 'string' }, title: { type: 'string' } }, required: ['action', 'path'] },
  kind: 'edit',
  key: (i) => i.path,
  summary: (i) => `${i.action} ${i.path}`,
  get readOnly() { return false; },
  async run({ action, path, format, content, title }, ctx) {
    const p = vfs.normalize(path, ctx.cwd);
    if (action === 'read') { const t = await readDocument(p); ctx.session?.markRead(p); return { content: clip(t, 60000), display: { kind: 'read', lines: t.split('\n').length } }; }
    const fmt = format || extOf(p);
    let blob;
    if (fmt === 'docx') blob = await makeDocx(content, title);
    else if (fmt === 'pdf') blob = await makePdf(content, title);
    else if (fmt === 'xlsx') blob = await makeXlsx(content);
    else if (fmt === 'pptx') blob = await makePptx(content, ctx.cwd);
    else blob = new Blob([content || ''], { type: mimeOf(p) });
    const out = p.endsWith('.' + fmt) ? p : `${p}.${fmt}`;
    const existed = await vfs.exists(out);
    await ctx.checkpoint?.(out, existed ? await vfs.readText(out).catch(() => null) : null);
    await vfs.write(out, blob);
    return { content: `${existed ? 'Updated' : 'Created'} ${out} (${Math.round(blob.size / 1024)} KB).`, display: { kind: 'file', path: out, size: blob.size } };
  },
};

export const ViewImage = {
  name: 'ViewImage',
  description: 'Look at an image file (photo, screenshot, chart). Vision models see it directly; other models get a description from the on-device vision model.',
  input_schema: { type: 'object', properties: { path: { type: 'string' }, question: { type: 'string' } }, required: ['path'] },
  readOnly: true, kind: 'read',
  summary: (i) => i.path,
  async run({ path, question }, ctx) {
    const p = vfs.normalize(path, ctx.cwd);
    const file = await vfs.getFile(p);
    const { fileToImageBlock } = await import('../../models/content.js');
    const img = await fileToImageBlock(file);
    const { parseRef, manifestFor } = await import('../../models/registry.js');
    const ref = ctx.session.modelRef();
    const pr = parseRef(ref);
    const vision = pr?.type === 'cloud' || !!manifestFor(ref)?.gguf?.mmproj;
    if (vision) return { content: [{ type: 'text', text: `Image ${p} (${img._w}x${img._h})` }, { type: 'image', source: img.source }], display: { kind: 'image', path: p } };
    const { describeImage } = await import('../../models/local/tjs.js');
    const url = URL.createObjectURL(file);
    try {
      ctx.onProgress?.('Describing the image with the on-device vision model…');
      const desc = await describeImage('HuggingFaceTB/SmolVLM-256M-Instruct', url, question || 'Describe this image in detail, including any text.');
      return { content: `Description of ${p} (from the on-device vision model):\n${desc}`, display: { kind: 'image', path: p } };
    } finally { URL.revokeObjectURL(url); }
  },
};

export const docTools = [Document, ViewImage];
