// Studio → Datasets: create, import, browse, synthesize (with a model), build from chats, split, upload.
import { html, useState, useEffect } from '../../../vendor/preact.mjs';
import { Icon } from '../icons.js';
import { Seg, toast, promptDialog, confirmDialog, openSheet, Empty, Progress, Banner } from '../kit.js';
import * as vfs from '../../core/vfs.js';
import { relTime, extractJSON } from '../../core/util.js';
import { listDatasets, readRows, createDataset, appendRows, importFile, fromChats, split, inspect, validateRow } from '../../studio/datasets.js';
import { modelFor, chat, modelLabel } from '../../models/registry.js';
import { textOf } from '../../models/content.js';
import { openFileInEditor } from '../layout.js';

const TYPE_HELP = {
  sft: 'Conversations: the model learns to answer like the assistant turns.',
  dpo: 'Preference pairs: a prompt with a better (chosen) and worse (rejected) answer.',
  grpo: 'Prompts (+ reference answers) for reinforcement learning with reward functions.',
  text: 'Plain text for continued pre-training or training from scratch.',
};

export function DatasetsPanel() {
  const [list, setList] = useState(null);
  const [open, setOpen] = useState(null);
  const load = () => listDatasets().then(setList);
  useEffect(() => { load(); const off = vfs.events.on('change', (e) => e.path.startsWith('/datasets') && load()); return off; }, []);
  if (open) return html`<${DatasetDetail} name=${open} back=${() => { setOpen(null); load(); }} />`;
  const create = () => openSheet({ title: 'New dataset' }, (close) => html`<${NewDataset} done=${(n) => { close(); load(); if (n) setOpen(n); }} />`);
  return html`<div class="page">
    <div class="row wrap"><button class="btn primary" onClick=${create}><${Icon} name="plus" />New dataset</button>
      <button class="btn" onClick=${async () => { const n = await fromChats('my-chats'); toast(`Added ${n} conversations to my-chats`, 'ok'); load(); }}><${Icon} name="chat" />From my chats</button></div>
    <div class="section-title">Your datasets</div>
    ${list && !list.length ? html`<${Empty} icon="dataset" title="No datasets yet">Create one, import a JSONL/CSV file, generate synthetic data with a model, or turn your chats into training data. Thumbs up/down in Chat also collect data automatically.<//>`
      : html`<div class="list">${(list || []).map(d => html`<button class="li" onClick=${() => setOpen(d.name)}><span class="li-icon"><${Icon} name="dataset" /></span>
        <div class="li-main"><div class="li-title">${d.name}</div><div class="li-sub">${d.type || 'sft'} · ${d.count ?? 0} rows${d.validation ? ` + ${d.validation} validation` : ''} · ${relTime(d.updated || 0)}</div></div><${Icon} name="chevronRight" /></button>`)}</div>`}
  </div>`;
}

function NewDataset({ done }) {
  const [name, setName] = useState('');
  const [type, setType] = useState('sft');
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const go = async () => {
    const n = name.trim().replace(/[^\w.-]+/g, '-'); if (!n) return toast('Name it first', 'warn');
    setBusy(true);
    try { if (file) await importFile(n, file, type); else await createDataset(n, { type }); done(n); }
    catch (e) { toast(String(e.message || e), 'err', 6000); setBusy(false); }
  };
  return html`<div class="field"><label>Name</label><input class="input" value=${name} onInput=${e => setName(e.target.value)} placeholder="support-replies" /></div>
    <div class="field"><label>Type</label><${Seg} block value=${type} onChange=${setType} options=${[{ value: 'sft', label: 'Chat (SFT)' }, { value: 'dpo', label: 'Preferences' }, { value: 'grpo', label: 'RL prompts' }, { value: 'text', label: 'Text' }]} /><div class="help">${TYPE_HELP[type]}</div></div>
    <div class="field"><label>Import a file (optional)</label><input type="file" accept=".jsonl,.json,.csv,.txt,.md" onChange=${e => setFile(e.target.files[0])} />
      <div class="help">JSONL/JSON/CSV. Common shapes are converted: {instruction, input, output}, {prompt, completion}, {question, answer}, {messages}.</div></div>
    <button class="btn primary block" disabled=${busy} onClick=${go}>${busy ? html`<div class="spinner"></div>` : 'Create'}</button>`;
}

function rowColumns(type) {
  if (type === 'sft') return [['User', r => r.messages?.filter(m => m.role === 'user').map(m => m.content).join('\n---\n')], ['Assistant', r => r.messages?.filter(m => m.role === 'assistant').map(m => m.content).join('\n---\n')]];
  if (type === 'dpo') return [['Prompt', r => r.prompt], ['Chosen', r => r.chosen], ['Rejected', r => r.rejected]];
  if (type === 'grpo') return [['Prompt', r => r.prompt], ['Answer', r => r.answer ?? '']];
  return [['Text', r => r.text]];
}

function DatasetDetail({ name, back }) {
  const [info, setInfo] = useState(null);
  const [rows, setRows] = useState(null);
  const load = async () => { setInfo(await inspect(name)); setRows(await readRows(name, 'data.jsonl', 300)); };
  useEffect(() => { load(); }, [name]);
  if (!info) return html`<div class="page"><div class="spinner"></div></div>`;
  const cols = rowColumns(info.type);
  const addRow = async () => {
    const tpl = { sft: { messages: [{ role: 'user', content: '' }, { role: 'assistant', content: '' }] }, dpo: { prompt: '', chosen: '', rejected: '' }, grpo: { prompt: '', answer: '' }, text: { text: '' } }[info.type];
    const v = await promptDialog({ title: 'Add a row (JSON)', value: JSON.stringify(tpl, null, 2), multiline: true, mono: true });
    if (!v) return;
    try { await appendRows(name, [JSON.parse(v)]); load(); } catch (e) { toast(String(e.message || e), 'err'); }
  };
  return html`<div class="page">
    <button class="btn ghost sm" style="margin-left:-8px" onClick=${back}><${Icon} name="chevronLeft" />Datasets</button>
    <div class="run-head" style="margin:6px 0 12px"><h2 style="margin:0">${name}</h2><span class="tag accent">${info.type}</span><span class="tag">${info.count} rows</span>${info.validation ? html`<span class="tag">${info.validation} validation</span>` : ''}</div>
    ${info.description && html`<div class="dim small" style="margin-bottom:10px">${info.description}</div>`}
    ${info.invalidRows.length > 0 && html`<${Banner} kind="warn" icon="alert">${info.invalidRows.length} invalid row(s), e.g. row ${info.invalidRows[0][0]}: ${info.invalidRows[0][1]}<//>`}
    <div class="row wrap" style="margin:10px 0">
      <button class="btn sm" onClick=${addRow}><${Icon} name="plus" />Add row</button>
      <button class="btn sm" onClick=${() => openSheet({ title: 'Generate synthetic data' }, (close) => html`<${Synth} name=${name} type=${info.type} done=${() => { close(); load(); }} />`)}><${Icon} name="sparkles" />Generate</button>
      <button class="btn sm" onClick=${async () => { const inp = Object.assign(document.createElement('input'), { type: 'file', accept: '.jsonl,.json,.csv,.txt' }); inp.onchange = async () => { try { await importFile(name, inp.files[0], info.type); load(); toast('Imported', 'ok'); } catch (e) { toast(e.message, 'err'); } }; inp.click(); }}><${Icon} name="upload" />Import</button>
      <button class="btn sm" onClick=${async () => { const r = await split(name, 0.1); toast(`${r.train} train / ${r.val} validation`, 'ok'); load(); }}><${Icon} name="scissors" />Split 90/10</button>
      <button class="btn sm" onClick=${() => openFileInEditor(`/datasets/${name}/data.jsonl`)}><${Icon} name="code" />Edit JSONL</button>
      <button class="btn sm" onClick=${() => uploadDataset(name)}><${Icon} name="cloud" />Upload to HF</button>
      <button class="btn sm danger" onClick=${async () => { if (await confirmDialog({ title: `Delete ${name}?`, ok: 'Delete', danger: true })) { await vfs.rm(`/datasets/${name}`); back(); } }}><${Icon} name="trash" /></button>
    </div>
    <div class="small dim" style="margin-bottom:6px">Average ${info.avgChars} characters per row (≈ ${Math.round(info.avgChars / 3.6)} tokens). Showing the first ${Math.min(300, rows?.length || 0)} rows.</div>
    <div class="table-wrap"><table class="dtable"><thead><tr><th>#</th>${cols.map(c => html`<th>${c[0]}</th>`)}</tr></thead>
      <tbody>${(rows || []).map((r, i) => html`<tr><td class="dim">${i + 1}</td>${cols.map(c => html`<td>${String(c[1](r) ?? '').slice(0, 600)}</td>`)}</tr>`)}</tbody></table></div>
  </div>`;
}

async function uploadDataset(name) {
  const repo = await promptDialog({ title: 'Upload to Hugging Face', label: 'Dataset repo (you/name). Needs an HF token with write access in Settings.', placeholder: 'yourname/' + name });
  if (!repo) return;
  try {
    const hf = await import('../../models/hf.js');
    await hf.createRepo(repo, { type: 'dataset' });
    const files = [{ path: 'train.jsonl', data: await vfs.getFile(`/datasets/${name}/data.jsonl`) }];
    if (await vfs.exists(`/datasets/${name}/validation.jsonl`)) files.push({ path: 'validation.jsonl', data: await vfs.getFile(`/datasets/${name}/validation.jsonl`) });
    await hf.uploadFiles(repo, files, { type: 'dataset' });
    toast(`Uploaded to huggingface.co/datasets/${repo}`, 'ok', 6000);
  } catch (e) { toast(String(e.message || e), 'err', 8000); }
}

function Synth({ name, type, done }) {
  const [topic, setTopic] = useState('');
  const [n, setN] = useState(20);
  const [prog, setProg] = useState(null);
  const ref = modelFor('agent');
  const shape = { sft: '{"messages":[{"role":"user","content":"…"},{"role":"assistant","content":"…"}]}', dpo: '{"prompt":"…","chosen":"(a great answer)","rejected":"(a plausible but worse answer)"}', grpo: '{"prompt":"…","answer":"(short exact final answer)"}', text: '{"text":"…"}' }[type];
  const go = async () => {
    setProg({ done: 0, total: n });
    let made = 0, tries = 0;
    while (made < n && tries < n) {
      tries++;
      const batch = Math.min(5, n - made);
      try {
        const r = await chat(ref, { system: 'You create high-quality, varied training data. Output ONLY a JSON array, no commentary.', messages: [{ role: 'user', content: `Create ${batch} diverse training examples for this goal: ${topic}\nEach item must be exactly this JSON shape: ${shape}\nVary difficulty, phrasing and length. Return a JSON array of ${batch} items.` }], maxTokens: 3000, thinking: 'off' });
        let arr = extractJSON(textOf(r.content));
        if (!Array.isArray(arr)) arr = arr ? [arr] : [];
        const good = arr.filter(x => !validateRow(x, type));
        if (good.length) { await appendRows(name, good); made += good.length; }
      } catch (e) { toast(String(e.message || e), 'err'); break; }
      setProg({ done: made, total: n });
    }
    toast(`Generated ${made} rows with ${modelLabel(ref)}`, 'ok');
    done();
  };
  return html`<${Banner} icon="sparkles">Uses ${ref ? modelLabel(ref) : 'your agent model'} to write examples. Bigger models (or a cloud model) give better data; always skim the results.<//>
    <div class="field" style="margin-top:12px"><label>What should the data teach?</label><textarea class="textarea" rows="4" value=${topic} onInput=${e => setTopic(e.target.value)} placeholder="e.g. Answer customer questions about our bakery's opening hours, prices and allergens in a friendly tone."></textarea></div>
    <div class="field"><label>How many rows: ${n}</label><input type="range" min="5" max="200" step="5" value=${n} onInput=${e => setN(Number(e.target.value))} /></div>
    ${prog ? html`<${Progress} value=${prog.done} max=${prog.total} /><div class="small dim" style="margin-top:6px">${prog.done} / ${prog.total}</div>` : html`<button class="btn primary block" disabled=${!topic.trim() || !ref} onClick=${go}>Generate</button>`}`;
}
