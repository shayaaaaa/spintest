// File tools: Read, Write, Edit, MultiEdit, Glob, Grep, LS (Claude Code–compatible semantics).
import * as vfs from '../../core/vfs.js';
import { clip, isTextName, extOf, globToRegExp, lineDiff, diffStats, mimeOf } from '../../core/util.js';
import { blobToBase64 } from '../../models/content.js';

const abs = (ctx, p) => vfs.normalize(p || '.', ctx.cwd);
const MAX_READ_LINES = 2000;

async function readPdfText(file) {
  const pdfjs = await import('../../../vendor/pdfjs/pdf.min.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc = new URL('../../../vendor/pdfjs/pdf.worker.min.mjs', import.meta.url).href;
  const doc = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  const out = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const tc = await page.getTextContent();
    out.push(`--- Page ${i} ---\n` + tc.items.map(it => it.str + (it.hasEOL ? '\n' : ' ')).join(''));
  }
  return out.join('\n\n');
}
export { readPdfText };

export const Read = {
  name: 'Read',
  description: 'Read a file from the Hub/workspace. Returns lines numbered like `cat -n` (up to 2000 lines; use offset/limit for long files). Images are returned visually, PDFs and .docx as text. Read a file before editing it.',
  input_schema: { type: 'object', properties: { file_path: { type: 'string', description: 'Absolute path (e.g. /workspace/app/index.js) or relative to the working directory' }, offset: { type: 'number', description: 'Line to start from (1-based)' }, limit: { type: 'number', description: 'Number of lines to read' } }, required: ['file_path'] },
  readOnly: true, kind: 'read',
  key: (i) => i.file_path,
  summary: (i) => i.file_path,
  async run({ file_path, offset, limit }, ctx) {
    const p = abs(ctx, file_path);
    const st = await vfs.stat(p);
    if (st.kind === 'directory') throw new Error(`${p} is a directory. Use LS to list it.`);
    const file = await vfs.getFile(p);
    const ext = extOf(p);
    ctx.session?.markRead(p, st.mtime);
    if (['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(ext)) {
      if (file.size > 8e6) throw new Error('Image too large (over 8 MB).');
      const data = await blobToBase64(file);
      return { content: [{ type: 'text', text: `Image ${p} (${Math.round(file.size / 1024)} KB)` }, { type: 'image', source: { type: 'base64', media_type: mimeOf(p), data } }], display: { kind: 'read', lines: 0, image: true } };
    }
    if (ext === 'pdf') { const t = await readPdfText(file); return { content: clip(t, 60000), display: { kind: 'read', lines: t.split('\n').length } }; }
    if (ext === 'docx') { const { mammoth } = await import('../../../vendor/office.mjs'); const r = await mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() }); return { content: clip(r.value, 60000), display: { kind: 'read', lines: r.value.split('\n').length } }; }
    if (!isTextName(p) && file.size > 0) {
      const head = new Uint8Array(await file.slice(0, 4096).arrayBuffer());
      if (head.some(b => b === 0)) return `Binary file ${p} (${file.size} bytes). It can't be shown as text.`;
    }
    const text = await file.text();
    if (!text) return { content: `<system-reminder>File ${p} exists but is empty.</system-reminder>`, display: { kind: 'read', lines: 0 } };
    const lines = text.split('\n');
    const start = Math.max(1, offset || 1);
    const n = Math.min(limit || MAX_READ_LINES, MAX_READ_LINES);
    const slice = lines.slice(start - 1, start - 1 + n);
    const body = slice.map((l, i) => `${String(start + i).padStart(6)}\t${l.length > 2000 ? l.slice(0, 2000) + '…' : l}`).join('\n');
    const more = start - 1 + n < lines.length ? `\n\n(${lines.length - (start - 1 + n)} more lines; use offset/limit to read further)` : '';
    return { content: body + more, display: { kind: 'read', lines: slice.length, total: lines.length } };
  },
};

function requireRead(ctx, p, st) {
  const seen = ctx.session?.readFiles?.get(p);
  if (!seen) throw new Error(`File has not been read yet. Read ${p} first before writing to it.`);
  if (st?.mtime && seen < st.mtime - 2) throw new Error(`${p} was modified since you last read it. Read it again before editing.`);
}

export const Write = {
  name: 'Write',
  description: 'Write a file (creates folders as needed; overwrites existing files, which must be Read first). Prefer Edit for changes to existing files.',
  input_schema: { type: 'object', properties: { file_path: { type: 'string' }, content: { type: 'string' } }, required: ['file_path', 'content'] },
  kind: 'edit',
  key: (i) => i.file_path,
  summary: (i) => i.file_path,
  async preview({ file_path, content }, ctx) {
    const p = abs(ctx, file_path);
    const before = await vfs.readText(p).catch(() => null);
    return { type: 'diff', path: p, before: before ?? '', after: content, created: before == null };
  },
  async run({ file_path, content }, ctx) {
    const p = abs(ctx, file_path);
    const st = await vfs.stat(p).catch(() => null);
    if (st?.kind === 'directory') throw new Error(`${p} is a directory`);
    let before = '';
    if (st) { requireRead(ctx, p, st); before = await vfs.readText(p); }
    await ctx.checkpoint?.(p, st ? before : null);
    await vfs.write(p, content);
    ctx.session?.markRead(p, Date.now());
    const d = diffStats(lineDiff(before, content));
    return { content: st ? `Updated ${p} (${content.split('\n').length} lines).` : `Created ${p} (${content.split('\n').length} lines).`, display: { kind: 'diff', path: p, before, after: content, created: !st, ...d } };
  },
};

function applyEdit(text, { old_string, new_string, replace_all }, p) {
  if (old_string === new_string) throw new Error('old_string and new_string are identical.');
  if (old_string === '') {
    if (text !== '') throw new Error('old_string is empty but the file is not; give the exact text to replace.');
    return new_string;
  }
  const count = text.split(old_string).length - 1;
  if (count === 0) {
    // Helpful hint: whitespace-insensitive match exists?
    const norm = (s) => s.replace(/\s+/g, ' ').trim();
    const hint = norm(text).includes(norm(old_string)) ? ' (a match exists if whitespace is ignored: copy indentation exactly from the Read output, without the line-number prefix)' : '';
    throw new Error(`old_string not found in ${p}${hint}.`);
  }
  if (count > 1 && !replace_all) throw new Error(`old_string appears ${count} times in ${p}. Add more surrounding context to make it unique, or set replace_all.`);
  return replace_all ? text.split(old_string).join(new_string) : text.replace(old_string, () => new_string);
}

export const Edit = {
  name: 'Edit',
  description: 'Replace exact text in a file. old_string must match the file exactly (including indentation) and be unique unless replace_all is true. Read the file first.',
  input_schema: { type: 'object', properties: { file_path: { type: 'string' }, old_string: { type: 'string' }, new_string: { type: 'string' }, replace_all: { type: 'boolean' } }, required: ['file_path', 'old_string', 'new_string'] },
  kind: 'edit',
  key: (i) => i.file_path,
  summary: (i) => i.file_path,
  async preview(input, ctx) {
    const p = abs(ctx, input.file_path);
    const before = await vfs.readText(p).catch(() => '');
    let after; try { after = applyEdit(before, input, p); } catch (e) { return { type: 'text', text: e.message }; }
    return { type: 'diff', path: p, before, after };
  },
  async run(input, ctx) {
    const p = abs(ctx, input.file_path);
    const st = await vfs.stat(p).catch(() => null);
    let before = '';
    if (st) { requireRead(ctx, p, st); before = await vfs.readText(p); }
    else if (input.old_string !== '') throw new Error(`${p} does not exist.`);
    const after = applyEdit(before, input, p);
    await ctx.checkpoint?.(p, st ? before : null);
    await vfs.write(p, after);
    ctx.session?.markRead(p, Date.now());
    const d = diffStats(lineDiff(before, after));
    return { content: `Edited ${p}: +${d.add} -${d.del}`, display: { kind: 'diff', path: p, before, after, ...d } };
  },
};

export const MultiEdit = {
  name: 'MultiEdit',
  description: 'Make several exact-text edits to one file in order, atomically (all succeed or none are applied).',
  input_schema: { type: 'object', properties: { file_path: { type: 'string' }, edits: { type: 'array', items: { type: 'object', properties: { old_string: { type: 'string' }, new_string: { type: 'string' }, replace_all: { type: 'boolean' } }, required: ['old_string', 'new_string'] } } }, required: ['file_path', 'edits'] },
  kind: 'edit',
  key: (i) => i.file_path,
  summary: (i) => `${i.file_path} (${i.edits?.length || 0} edits)`,
  async preview(input, ctx) {
    const p = abs(ctx, input.file_path);
    const before = await vfs.readText(p).catch(() => '');
    let after = before;
    try { for (const e of input.edits) after = applyEdit(after, e, p); } catch (e) { return { type: 'text', text: e.message }; }
    return { type: 'diff', path: p, before, after };
  },
  async run(input, ctx) {
    const p = abs(ctx, input.file_path);
    const st = await vfs.stat(p).catch(() => null);
    let before = '';
    if (st) { requireRead(ctx, p, st); before = await vfs.readText(p); }
    let after = before;
    input.edits.forEach((e, i) => { try { after = applyEdit(after, e, p); } catch (err) { throw new Error(`Edit ${i + 1}: ${err.message}`); } });
    await ctx.checkpoint?.(p, st ? before : null);
    await vfs.write(p, after);
    ctx.session?.markRead(p, Date.now());
    const d = diffStats(lineDiff(before, after));
    return { content: `Applied ${input.edits.length} edits to ${p}: +${d.add} -${d.del}`, display: { kind: 'diff', path: p, before, after, ...d } };
  },
};

export const Glob = {
  name: 'Glob',
  description: 'Find files by glob pattern (e.g. "**/*.js", "src/**/*.{ts,tsx}"). Results are sorted by modification time, newest first.',
  input_schema: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string', description: 'Folder to search (default: working directory)' } }, required: ['pattern'] },
  readOnly: true, kind: 'read',
  summary: (i) => i.pattern + (i.path ? ` in ${i.path}` : ''),
  async run({ pattern, path }, ctx) {
    const base = abs(ctx, path || '.');
    const res = await vfs.glob(pattern, base);
    if (!res.length) return { content: 'No files found', display: { kind: 'count', n: 0 } };
    const shown = res.slice(0, 200);
    return { content: shown.join('\n') + (res.length > 200 ? `\n(${res.length - 200} more)` : ''), display: { kind: 'count', n: res.length, noun: 'file' } };
  },
};

const TYPE_EXT = { js: 'js,mjs,cjs,jsx', ts: 'ts,tsx', py: 'py', html: 'html,htm', css: 'css,scss', md: 'md,markdown', json: 'json', rust: 'rs', go: 'go', java: 'java', c: 'c,h', cpp: 'cpp,cc,hpp,h', swift: 'swift', sh: 'sh,bash' };

export const Grep = {
  name: 'Grep',
  description: 'Search file contents with a regular expression. output_mode: "files_with_matches" (default), "content" (matching lines, with -n line numbers and -A/-B/-C context), or "count". Filter with glob (e.g. "*.js") or type (js, py, ts…).',
  input_schema: { type: 'object', properties: {
    pattern: { type: 'string' }, path: { type: 'string' }, glob: { type: 'string' }, type: { type: 'string' },
    output_mode: { type: 'string', enum: ['content', 'files_with_matches', 'count'] }, '-i': { type: 'boolean' }, '-n': { type: 'boolean' },
    '-A': { type: 'number' }, '-B': { type: 'number' }, '-C': { type: 'number' }, head_limit: { type: 'number' }, multiline: { type: 'boolean' },
  }, required: ['pattern'] },
  readOnly: true, kind: 'read',
  summary: (i) => `"${i.pattern}"` + (i.path ? ` in ${i.path}` : '') + (i.glob ? ` (${i.glob})` : ''),
  async run(i, ctx) {
    const base = abs(ctx, i.path || '.');
    let re;
    try { re = new RegExp(i.pattern, (i['-i'] ? 'i' : '') + (i.multiline ? 'ms' : '') + 'g'); } catch (e) { throw new Error('Invalid regex: ' + e.message); }
    const mode = i.output_mode || 'files_with_matches';
    const exts = i.type ? new Set((TYPE_EXT[i.type] || i.type).split(',')) : null;
    const gre = i.glob ? globToRegExp(i.glob.includes('/') ? i.glob : '**/' + i.glob) : null;
    const st = await vfs.stat(base);
    const files = st.kind === 'file' ? [{ path: base, name: vfs.basename(base) }] : [];
    if (st.kind === 'directory') for await (const e of vfs.walk(base)) files.push(e);
    const out = []; let total = 0, nFiles = 0;
    const B = i['-B'] ?? i['-C'] ?? 0, A = i['-A'] ?? i['-C'] ?? 0;
    const limit = i.head_limit || 250;
    for (const f of files) {
      if (exts && !exts.has(extOf(f.name))) continue;
      if (gre && !gre.test(f.path.slice(base.length + 1) || f.name)) continue;
      if (!isTextName(f.name)) continue;
      let text; try { const file = await vfs.getFile(f.path); if (file.size > 2e6) continue; text = await file.text(); } catch { continue; }
      re.lastIndex = 0;
      if (!re.test(text)) continue;
      nFiles++;
      if (mode === 'files_with_matches') { out.push(f.path); if (out.length >= limit) break; continue; }
      const lines = text.split('\n');
      let count = 0;
      const lre = new RegExp(i.pattern, i['-i'] ? 'i' : '');
      const keep = new Set();
      lines.forEach((l, idx) => { if (lre.test(l)) { count++; for (let k = Math.max(0, idx - B); k <= Math.min(lines.length - 1, idx + A); k++) keep.add(k); } });
      total += count;
      if (mode === 'count') { out.push(`${f.path}:${count}`); continue; }
      let prev = -2;
      for (const k of [...keep].sort((a, b) => a - b)) {
        if (prev >= 0 && k > prev + 1) out.push('--');
        out.push(`${f.path}:${i['-n'] !== false ? (k + 1) + ':' : ''}${lines[k].slice(0, 500)}`);
        prev = k;
        if (out.length >= limit) break;
      }
      if (out.length >= limit) break;
    }
    if (!out.length) return { content: 'No matches found', display: { kind: 'count', n: 0 } };
    return { content: clip(out.join('\n'), 30000), display: { kind: 'count', n: mode === 'content' ? total : nFiles, noun: mode === 'content' ? 'match' : 'file' } };
  },
};

export const LS = {
  name: 'LS',
  description: 'List a folder (names, sizes; folders end with /).',
  input_schema: { type: 'object', properties: { path: { type: 'string' }, ignore: { type: 'array', items: { type: 'string' } } } },
  readOnly: true, kind: 'read',
  summary: (i) => i.path || '.',
  async run({ path, ignore }, ctx) {
    const p = abs(ctx, path || '.');
    const ig = (ignore || []).map(g => globToRegExp(g));
    const items = (await vfs.list(p)).filter(e => !ig.some(r => r.test(e.name)));
    const lines = items.slice(0, 500).map(e => `${e.kind === 'directory' ? e.name + '/' : e.name}${e.kind === 'file' ? `  (${e.size} B)` : ''}`);
    return { content: `${p}/\n` + (lines.join('\n') || '(empty)'), display: { kind: 'count', n: items.length, noun: 'item' } };
  },
};

export const fsTools = [Read, Write, Edit, MultiEdit, Glob, Grep, LS];
