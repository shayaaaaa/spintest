// Studio → Evaluate: A/B arena between any two models (votes become DPO preference data), perplexity of Forge models
// on a dataset, generation speed, and a GPU benchmark for the training estimator.
import { html, useState, useEffect } from '../../../vendor/preact.mjs';
import { useStore } from '../../core/store.js';
import { Icon } from '../icons.js';
import { Seg, Progress, Banner, toast, Markdown } from '../kit.js';
import { modelsStore, refreshModels, chatModels, chat, modelLabel, unloadLocal } from '../../models/registry.js';
import { listDatasets, readRows, addPreference } from '../../studio/datasets.js';
import { normalizeRow } from '../../forge/data.js';
import { settings } from '../../core/settings.js';

const textOf = (r) => r.content.filter(b => b.type === 'text').map(b => b.text).join('').trim();

export function EvalPanel() {
  const [tab, setTab] = useState('arena');
  useEffect(() => { refreshModels(); }, []);
  return html`<div class="page">
    <${Seg} block value=${tab} onChange=${setTab} options=${[{ value: 'arena', label: 'Arena' }, { value: 'ppl', label: 'Perplexity' }, { value: 'speed', label: 'Speed' }]} />
    <div style="margin-top:12px">${tab === 'arena' ? html`<${Arena} />` : tab === 'ppl' ? html`<${Perplexity} />` : html`<${Speed} />`}</div>
  </div>`;
}

function ModelSelect({ value, onChange, filter = () => true }) {
  useStore(modelsStore);
  const list = chatModels().filter(filter);
  return html`<select class="input select" value=${value} onChange=${e => onChange(e.target.value)}>
    <option value="">Choose…</option>${list.map(m => html`<option value=${m.ref}>${m.label} · ${m.sub || (m.local ? 'local' : 'cloud')}</option>`)}</select>`;
}

function Arena() {
  const [a, setA] = useState('');
  const [b, setB] = useState('');
  const [prompts, setPrompts] = useState('Explain what a LoRA adapter is in two sentences.\nWrite a haiku about folding phones.');
  const [ds, setDs] = useState('');
  const [datasets, setDatasets] = useState([]);
  const [results, setResults] = useState([]);
  const [busy, setBusy] = useState(null);
  useEffect(() => { listDatasets().then(setDatasets); }, []);
  const fromDataset = async (name) => {
    setDs(name); if (!name) return;
    const rows = await readRows(name, 'data.jsonl', 200);
    const ps = rows.map(r => { const n = normalizeRow(r); return n?.messages?.find(m => m.role === 'user')?.content ?? r.prompt ?? r.question; }).filter(Boolean);
    setPrompts(ps.sort(() => Math.random() - 0.5).slice(0, 5).join('\n'));
  };
  const run = async () => {
    if (!a || !b) return toast('Pick two models', 'warn');
    const list = prompts.split('\n').map(s => s.trim()).filter(Boolean).slice(0, 20);
    setResults(list.map(p => ({ prompt: p })));
    for (const [side, ref] of [['a', a], ['b', b]]) {
      for (let i = 0; i < list.length; i++) {
        setBusy(`${modelLabel(ref)}: ${i + 1}/${list.length}`);
        try {
          const t0 = performance.now();
          const r = await chat(ref, { messages: [{ role: 'user', content: list[i] }], maxTokens: 400, temperature: 0.7, thinking: 'off' });
          const out = { text: textOf(r), ms: performance.now() - t0, tps: r.usage?.tps };
          setResults(rs => rs.map((x, j) => j === i ? { ...x, [side]: out } : x));
        } catch (e) { setResults(rs => rs.map((x, j) => j === i ? { ...x, [side]: { text: 'Error: ' + e.message } } : x)); }
      }
      await unloadLocal().catch(() => {});
    }
    setBusy(null);
  };
  const vote = async (i, w) => {
    const r = results[i];
    setResults(rs => rs.map((x, j) => j === i ? { ...x, vote: w } : x));
    if (w === 'tie') return;
    await addPreference({ prompt: r.prompt, chosen: r[w].text, rejected: r[w === 'a' ? 'b' : 'a'].text });
    toast('Saved to chat-preferences (for DPO)', 'ok');
  };
  const score = results.reduce((s, r) => ({ a: s.a + (r.vote === 'a'), b: s.b + (r.vote === 'b'), tie: s.tie + (r.vote === 'tie') }), { a: 0, b: 0, tie: 0 });
  return html`<div class="card">
      <div class="inline-fields"><div class="field"><label>Model A</label><${ModelSelect} value=${a} onChange=${setA} /></div><div class="field"><label>Model B</label><${ModelSelect} value=${b} onChange=${setB} /></div></div>
      <div class="field"><label>Prompts (one per line)</label><textarea class="input textarea" rows="4" value=${prompts} onInput=${e => setPrompts(e.target.value)}></textarea>
        <select class="input select" style="margin-top:6px" value=${ds} onChange=${e => fromDataset(e.target.value)}><option value="">…or sample prompts from a dataset</option>${datasets.map(d => html`<option value=${d.name}>${d.name}</option>`)}</select></div>
      <button class="btn primary block" disabled=${!!busy} onClick=${run}>${busy ? html`<div class="spinner"></div> ${busy}` : html`<${Icon} name="swap" />Compare`}</button>
      <div class="help" style="margin-top:6px">Votes are saved as preference pairs (dataset "chat-preferences") so you can DPO-train the better behaviour in.</div></div>
    ${results.some(r => r.vote) && html`<div class="stats" style="margin-top:10px"><div class="stat"><div class="stat-k">A wins</div><div class="stat-v">${score.a}</div></div><div class="stat"><div class="stat-k">B wins</div><div class="stat-v">${score.b}</div></div><div class="stat"><div class="stat-k">Ties</div><div class="stat-v">${score.tie}</div></div></div>`}
    ${results.map((r, i) => html`<div class="card" style="margin-top:10px"><div class="card-title"><${Icon} name="chat" />${r.prompt}</div>
      <div class="arena-grid">${['a', 'b'].map(s => html`<div class=${'arena-col' + (r.vote === s ? ' won' : '')}><div class="small dim" style="margin-bottom:4px">${s.toUpperCase()} · ${modelLabel(s === 'a' ? a : b)}${r[s]?.ms ? ` · ${(r[s].ms / 1000).toFixed(1)}s` : ''}${r[s]?.tps ? ` · ${r[s].tps.toFixed(1)} tok/s` : ''}</div>
        ${r[s] ? html`<${Markdown} text=${r[s].text} />` : html`<div class="spinner"></div>`}</div>`)}</div>
      ${r.a && r.b && html`<div class="row wrap" style="margin-top:8px"><button class=${'btn sm' + (r.vote === 'a' ? ' primary' : '')} onClick=${() => vote(i, 'a')}>A is better</button><button class=${'btn sm' + (r.vote === 'tie' ? ' primary' : '')} onClick=${() => vote(i, 'tie')}>Tie</button><button class=${'btn sm' + (r.vote === 'b' ? ' primary' : '')} onClick=${() => vote(i, 'b')}>B is better</button></div>`}
    </div>`)}`;
}

function Perplexity() {
  const { local } = useStore(modelsStore);
  const forge = local.filter(m => m.engine === 'forge' && m.status === 'ready');
  const [model, setModel] = useState('');
  const [ds, setDs] = useState('');
  const [datasets, setDatasets] = useState([]);
  const [res, setRes] = useState([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => { listDatasets().then(d => { setDatasets(d); setDs(d[0]?.name || ''); }); }, []);
  useEffect(() => { if (!model && forge[0]) setModel(forge[0].ref); }, [forge.length]);
  const run = async () => {
    const m = forge.find(x => x.ref === model);
    if (!m || !ds) return;
    setBusy(true);
    try {
      await unloadLocal().catch(() => {});
      const { rpc } = await import('../../forge/client.js');
      await rpc('load', { dir: m.dir });
      const val = await readRows(ds, 'validation.jsonl', 64);
      const rows = val.length ? val : await readRows(ds, 'data.jsonl', 64);
      const r = await rpc('evaluate', { rows, maxRows: 64 });
      await rpc('unloadIfIdle');
      setRes(x => [{ model: m.name, dataset: ds + (val.length ? ' (validation)' : ''), ...r }, ...x]);
    } catch (e) { toast(String(e.message || e), 'err', 7000); }
    setBusy(false);
  };
  return html`<div class="card">
    ${!forge.length && html`<${Banner} icon="info">Perplexity runs on Forge (safetensors) models: base models from the Trainable section or merged exports of your runs.<//>`}
    <div class="inline-fields"><div class="field"><label>Model</label><select class="input select" value=${model} onChange=${e => setModel(e.target.value)}>${forge.map(m => html`<option value=${m.ref}>${m.name}</option>`)}</select></div>
      <div class="field"><label>Dataset</label><select class="input select" value=${ds} onChange=${e => setDs(e.target.value)}>${datasets.map(d => html`<option value=${d.name}>${d.name}</option>`)}</select></div></div>
    <button class="btn primary block" disabled=${busy || !forge.length} onClick=${run}>${busy ? html`<div class="spinner"></div>` : html`<${Icon} name="gauge" />Measure`}</button>
    <div class="help" style="margin-top:6px">Lower is better. Uses the validation split when there is one (up to 64 rows), scoring only assistant/target tokens.</div></div>
    ${res.length > 0 && html`<div class="table-wrap" style="margin-top:10px"><table class="dtable"><thead><tr><th>Model</th><th>Dataset</th><th>Loss</th><th>Perplexity</th><th>Tokens</th></tr></thead><tbody>
      ${res.map(r => html`<tr><td>${r.model}</td><td>${r.dataset}</td><td>${r.loss.toFixed(4)}</td><td>${r.perplexity.toFixed(2)}</td><td>${r.tokens}</td></tr>`)}</tbody></table></div>`}`;
}

function Speed() {
  const [model, setModel] = useState('');
  const [res, setRes] = useState([]);
  const [busy, setBusy] = useState(null);
  const gflops = useStore(settings, s => s.forge?.gflops);
  const run = async () => {
    if (!model) return;
    setBusy('Loading…');
    try {
      const t0 = performance.now();
      await chat(model, { messages: [{ role: 'user', content: 'Hi' }], maxTokens: 4, temperature: 0 });
      const load = performance.now() - t0;
      setBusy('Generating…');
      const t1 = performance.now();
      const r = await chat(model, { messages: [{ role: 'user', content: 'Write a 150-word story about a robot learning to paint.' }], maxTokens: 200, temperature: 0.7, thinking: 'off' });
      const ms = performance.now() - t1;
      setRes(x => [{ model: modelLabel(model), load, ms, out: r.usage?.output, tps: r.usage?.tps || (r.usage?.output / (ms / 1000)) }, ...x]);
    } catch (e) { toast(String(e.message || e), 'err'); }
    setBusy(null);
  };
  const bench = async () => {
    setBusy('Benchmarking GPU…');
    try { const { benchmark } = await import('../../forge/jobs.js'); const r = await benchmark(); toast(`${Math.round(r.gflops)} GFLOPS`, 'ok'); }
    catch (e) { toast(String(e.message || e), 'err'); }
    setBusy(null);
  };
  return html`<div class="card"><div class="field"><label>Model</label><${ModelSelect} value=${model} onChange=${setModel} /></div>
    <div class="row wrap"><button class="btn primary grow" disabled=${!!busy || !model} onClick=${run}>${busy ? html`<div class="spinner"></div> ${busy}` : html`<${Icon} name="zap" />Measure speed`}</button>
      <button class="btn" disabled=${!!busy} onClick=${bench}><${Icon} name="cpu" />GPU benchmark</button></div>
    <div class="help" style="margin-top:6px">${gflops ? `Training GPU: ${gflops} GFLOPS (used by the Train estimator).` : 'The GPU benchmark makes Train time estimates accurate for this phone.'}</div></div>
    ${res.length > 0 && html`<div class="table-wrap" style="margin-top:10px"><table class="dtable"><thead><tr><th>Model</th><th>Load</th><th>Tokens</th><th>Tok/s</th></tr></thead><tbody>
      ${res.map(r => html`<tr><td>${r.model}</td><td>${(r.load / 1000).toFixed(1)}s</td><td>${r.out ?? '—'}</td><td>${r.tps ? r.tps.toFixed(1) : '—'}</td></tr>`)}</tbody></table></div>`}`;
}
