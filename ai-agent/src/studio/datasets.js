// Datasets in Hub/datasets/<name>/: data.jsonl (+ validation.jsonl) and meta.json.
import * as vfs from '../core/vfs.js';
import { blocks, textOf } from '../models/content.js';

const dirOf = (name) => `/datasets/${String(name).replace(/[^\w.-]+/g, '-')}`;

export async function listDatasets() {
  const out = [];
  for (const e of await vfs.list('/datasets').catch(() => [])) {
    if (e.kind !== 'directory') continue;
    const meta = await vfs.readJSON(`${e.path}/meta.json`, {});
    out.push({ name: e.name, dir: e.path, ...meta });
  }
  return out.sort((a, b) => (b.updated || 0) - (a.updated || 0));
}

export async function readRows(name, file = 'data.jsonl', limit = Infinity) {
  const text = await vfs.readText(`${dirOf(name)}/${file}`).catch(() => '');
  const rows = [];
  for (const line of text.split('\n')) { if (!line.trim()) continue; try { rows.push(JSON.parse(line)); } catch {} if (rows.length >= limit) break; }
  return rows;
}

async function touchMeta(name, patch = {}) {
  const dir = dirOf(name);
  const meta = await vfs.readJSON(`${dir}/meta.json`, { name, type: 'sft', created: Date.now() });
  const count = (await vfs.readText(`${dir}/data.jsonl`).catch(() => '')).split('\n').filter(l => l.trim()).length;
  const next = { ...meta, ...patch, count, updated: Date.now() };
  await vfs.writeJSON(`${dir}/meta.json`, next);
  return next;
}

export function validateRow(row, type) {
  if (type === 'sft') return Array.isArray(row.messages) && row.messages.length >= 2 && row.messages.every(m => ['system', 'user', 'assistant'].includes(m.role) && typeof m.content === 'string') ? null : 'needs messages: [{role, content}…] with user and assistant turns';
  if (type === 'dpo') return typeof row.prompt === 'string' && typeof row.chosen === 'string' && typeof row.rejected === 'string' ? null : 'needs prompt, chosen, rejected';
  if (type === 'grpo') return typeof row.prompt === 'string' ? null : 'needs prompt (and answer for automatic rewards)';
  if (type === 'text') return typeof row.text === 'string' ? null : 'needs text';
  return null;
}

export async function createDataset(name, { type = 'sft', description = '', rows = [] } = {}) {
  const dir = dirOf(name);
  if (await vfs.exists(`${dir}/meta.json`)) throw new Error(`Dataset ${name} already exists`);
  for (const [i, r] of rows.entries()) { const e = validateRow(r, type); if (e) throw new Error(`Row ${i + 1}: ${e}`); }
  await vfs.write(`${dir}/data.jsonl`, rows.map(r => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));
  const meta = await touchMeta(name, { type, description, created: Date.now() });
  return { dir, count: meta.count };
}

export async function appendRows(name, rows) {
  const dir = dirOf(name);
  const meta = await vfs.readJSON(`${dir}/meta.json`, null);
  if (!meta) throw new Error(`No dataset named ${name}. Create it first.`);
  for (const [i, r] of rows.entries()) { const e = validateRow(r, meta.type); if (e) throw new Error(`Row ${i + 1}: ${e}`); }
  await vfs.append(`${dir}/data.jsonl`, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
  return (await touchMeta(name)).count;
}

export async function inspect(name) {
  const meta = await vfs.readJSON(`${dirOf(name)}/meta.json`, null);
  if (!meta) throw new Error(`No dataset named ${name}`);
  const rows = await readRows(name);
  const bad = rows.map((r, i) => [i + 1, validateRow(r, meta.type)]).filter(x => x[1]);
  const lens = rows.map(r => JSON.stringify(r).length);
  return { ...meta, count: rows.length, invalidRows: bad.slice(0, 10), avgChars: Math.round(lens.reduce((a, b) => a + b, 0) / (lens.length || 1)), maxChars: Math.max(0, ...lens), sample: rows.slice(0, 3) };
}

export async function split(name, frac = 0.1) {
  const rows = await readRows(name);
  for (let i = rows.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [rows[i], rows[j]] = [rows[j], rows[i]]; }
  const nVal = Math.max(1, Math.round(rows.length * frac));
  const val = rows.slice(0, nVal), train = rows.slice(nVal);
  await vfs.write(`${dirOf(name)}/data.jsonl`, train.map(r => JSON.stringify(r)).join('\n') + '\n');
  await vfs.write(`${dirOf(name)}/validation.jsonl`, val.map(r => JSON.stringify(r)).join('\n') + '\n');
  await touchMeta(name, { validation: nVal });
  return { train: train.length, val: nVal };
}

// Converts saved conversations (Hub/chats) into SFT rows (text-only turns).
export async function fromChats(name, { kinds = ['chat', 'agent'] } = {}) {
  if (!(await vfs.exists(`${dirOf(name)}/meta.json`))) await createDataset(name, { type: 'sft', description: 'From saved conversations' });
  const rows = [];
  for (const e of await vfs.list('/chats').catch(() => [])) {
    const d = await vfs.readJSON(e.path, null);
    if (!d || !kinds.includes(d.kind)) continue;
    const msgs = [];
    for (const m of d.messages || []) {
      const t = textOf(m.content).trim();
      if (!t || m._meta || blocks(m.content).some(b => b.type === 'tool_result')) continue;
      if (msgs.length && msgs[msgs.length - 1].role === m.role) msgs[msgs.length - 1].content += '\n\n' + t; else msgs.push({ role: m.role, content: t });
    }
    if (msgs.length >= 2 && msgs[0].role === 'user') rows.push({ messages: msgs[msgs.length - 1].role === 'assistant' ? msgs : msgs.slice(0, -1) });
  }
  if (rows.length) await appendRows(name, rows);
  return rows.length;
}

// Thumbs up/down in Chat become DPO preference pairs (chosen = liked reply, rejected = disliked regeneration).
export async function addPreference({ prompt, chosen, rejected }) {
  const name = 'chat-preferences';
  if (!(await vfs.exists(`${dirOf(name)}/meta.json`))) await createDataset(name, { type: 'dpo', description: 'Collected from thumbs up/down in Chat' });
  return appendRows(name, [{ prompt, chosen, rejected }]);
}

export async function importFile(name, file, type) {
  const text = await file.text();
  let rows = [];
  if (/\.jsonl$/i.test(file.name)) rows = text.split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
  else if (/\.json$/i.test(file.name)) { const j = JSON.parse(text); rows = Array.isArray(j) ? j : j.data || []; }
  else if (/\.csv$/i.test(file.name)) {
    const [head, ...lines] = text.split(/\r?\n/).filter(Boolean);
    const cols = head.split(',').map(s => s.trim().replace(/^"|"$/g, ''));
    rows = lines.map(l => { const v = l.match(/("([^"]|"")*"|[^,]*)(,|$)/g).map(x => x.replace(/,$/, '').replace(/^"|"$/g, '').replace(/""/g, '"')); return Object.fromEntries(cols.map((c, i) => [c, v[i]])); });
  } else rows = text.split(/\n{2,}/).filter(t => t.trim()).map(t => ({ text: t.trim() }));
  // Normalize common shapes: {instruction,input,output} / {prompt,completion} / {question,answer}
  rows = rows.map(r => {
    if (type === 'sft' && !r.messages) {
      const u = r.instruction ? (r.instruction + (r.input ? '\n\n' + r.input : '')) : r.prompt ?? r.question ?? r.input;
      const a = r.output ?? r.completion ?? r.response ?? r.answer;
      if (u != null && a != null) return { messages: [{ role: 'user', content: String(u) }, { role: 'assistant', content: String(a) }] };
    }
    if (type === 'grpo' && !r.prompt && r.question) return { prompt: r.question, answer: r.answer };
    return r;
  });
  if (!(await vfs.exists(`${dirOf(name)}/meta.json`))) await createDataset(name, { type, description: `Imported from ${file.name}` });
  return appendRows(name, rows);
}
