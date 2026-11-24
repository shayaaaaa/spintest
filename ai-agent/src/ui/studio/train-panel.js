// Studio → Train: configure fine-tuning / pre-training / from-scratch / DPO / GRPO runs on this phone (Forge engine),
// see the memory/time estimate, watch live loss curves and samples, pause/resume, try the model and export it.
import { html, useState, useEffect, useMemo, useRef } from '../../../vendor/preact.mjs';
import { useStore } from '../../core/store.js';
import { Icon } from '../icons.js';
import { Seg, Toggle, Progress, Banner, Empty, LineChart, toast, confirmDialog, openSheet, openMenu } from '../kit.js';
import { modelsStore, refreshModels } from '../../models/registry.js';
import { listDatasets } from '../../studio/datasets.js';
import { REWARDS } from '../../forge/rewards.js';
import { runsStore, loadRuns, startRun, stopRun, resumeRun, estimate, benchmark, exportRun, deleteRun, readMetrics, chatWithRun, METHODS, SCRATCH } from '../../forge/jobs.js';
import { settings } from '../../core/settings.js';
import { bus } from '../../core/bus.js';
import { fmtDuration, fmtNum, relTime, debounce } from '../../core/util.js';
import { openFileInEditor, openInHub } from '../layout.js';

const TARGETS = ['q', 'k', 'v', 'o', 'gate', 'up', 'down'];
const DATA_FOR = { sft: ['sft'], pretrain: ['text', 'sft'], scratch: ['text', 'sft'], dpo: ['dpo'], grpo: ['grpo'] };
const REWARD_TEMPLATE = `// Return a number for each completion. Higher is better.
// row is the dataset row (e.g. {prompt, answer}).
function reward(completion, row) {
  const answer = completion.split('</think>').pop();
  let score = answer.includes(String(row.answer)) ? 1 : 0;
  if (answer.length > 600) score -= 0.2; // prefer concise answers
  return score;
}`;
const STATE_TAG = { done: 'ok', training: 'accent', preparing: 'accent', saving: 'accent', queued: '', paused: 'warn', stopped: 'warn', interrupted: 'warn', error: 'err' };
const isLive = (s) => ['training', 'preparing', 'saving', 'queued'].includes(s);

export function TrainPanel() {
  const { runs, active } = useStore(runsStore);
  const [open, setOpen] = useState(null);
  const [showNew, setShowNew] = useState(false);
  useEffect(() => { loadRuns(); refreshModels(); }, []);
  useEffect(() => bus.on('studio-run', (id) => setOpen(id)), []);
  useEffect(() => { if (active) setOpen(active); }, [active]);
  if (open && runs.find(r => r.id === open)) return html`<${RunDetail} id=${open} back=${() => setOpen(null)} />`;
  return html`<div class="page">
    ${showNew || !runs.length ? html`<${NewRun} onStarted=${(id) => { setShowNew(false); setOpen(id); }} onCancel=${runs.length ? () => setShowNew(false) : null} />`
      : html`<button class="btn primary block" onClick=${() => setShowNew(true)}><${Icon} name="plus" />New training run</button>`}
    ${runs.length > 0 && html`<div class="section-title">Runs</div>
      <div class="list">${runs.map(r => html`<button class="li" onClick=${() => setOpen(r.id)}>
        <span class="li-icon"><${Icon} name=${r.method === 'grpo' ? 'target' : r.method === 'dpo' ? 'thumbUp' : r.method === 'scratch' ? 'sparkles' : 'flask'} /></span>
        <div class="li-main"><div class="li-title">${r.name} <span class=${'tag ' + (STATE_TAG[r.state] || '')}>${r.state}</span></div>
          <div class="li-sub">${METHODS[r.method]?.label || r.method}${r.method !== 'scratch' ? ' · ' + r.tuning : ''} · ${r.baseName || ''} · ${r.dataset} · ${r.total ? `${r.step}/${r.total} steps` : relTime(r.created)}${r.loss != null ? ` · loss ${r.loss.toFixed(3)}` : ''}</div>
          ${isLive(r.state) && r.total ? html`<div style="margin-top:6px"><${Progress} value=${r.step / r.total} /></div>` : ''}</div><${Icon} name="chevronRight" /></button>`)}</div>`}
  </div>`;
}

function useDebounced(value, ms) {
  const [v, setV] = useState(value);
  useEffect(() => { const t = setTimeout(() => setV(value), ms); return () => clearTimeout(t); }, [JSON.stringify(value)]);
  return v;
}

function NewRun({ onStarted, onCancel }) {
  const { local } = useStore(modelsStore);
  const trainable = local.filter(m => m.engine === 'forge' && m.status === 'ready');
  const [datasets, setDatasets] = useState([]);
  useEffect(() => { listDatasets().then(setDatasets); }, []);
  const [f, setF] = useState({ method: 'sft', tuning: 'lora', base: '', dataset: '', name: '', size: 'micro', epochs: 1, maxSteps: 0, lr: 0, batch: 8, seqLen: 0, rank: 16, alpha: 32, targets: TARGETS, beta: 0.1, group: 4, maxNew: 256, temperature: 0.9, reward: 'exact', customReward: false, rewardCode: REWARD_TEMPLATE, vocabSize: 0, completionOnly: true, warmup: '', wd: '', saveEvery: 0 });
  const set = (k, v) => setF(s => ({ ...s, [k]: v }));
  const [adv, setAdv] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (!f.base && trainable[0]) set('base', trainable[0].ref); }, [trainable.length]);
  const okSets = datasets.filter(d => DATA_FOR[f.method].includes(d.type || 'sft'));
  useEffect(() => { if (!okSets.find(d => d.name === f.dataset)) set('dataset', okSets[0]?.name || ''); }, [f.method, datasets.length]);
  const req = () => ({
    method: f.method === 'scratch' ? 'pretrain' : f.method, base: f.method === 'scratch' ? 'scratch' : f.base, tuning: f.method === 'scratch' ? 'full' : f.tuning,
    dataset: f.dataset, name: f.name || undefined, size: f.size, vocabSize: +f.vocabSize || undefined, epochs: +f.epochs || 1, maxSteps: +f.maxSteps || undefined, lr: +f.lr || undefined,
    batch: +f.batch || undefined, seqLen: +f.seqLen || undefined, rank: +f.rank, alpha: +f.alpha, targets: f.targets, beta: f.method === 'dpo' || f.method === 'grpo' ? +f.beta : undefined,
    group: +f.group, maxNew: +f.maxNew, temperature: +f.temperature, reward: f.customReward ? undefined : f.reward, rewardCode: f.customReward ? f.rewardCode : undefined,
    completionOnly: f.completionOnly, warmup: f.warmup === '' ? undefined : +f.warmup, wd: f.wd === '' ? undefined : +f.wd, saveEvery: +f.saveEvery || undefined,
  });
  const estReq = useDebounced(req(), 350);
  const [est, setEst] = useState(null);
  const [estErr, setEstErr] = useState(null);
  const gflops = useStore(settings, s => s.forge?.gflops);
  useEffect(() => { if (estReq.method !== 'pretrain' && estReq.base !== 'scratch' && !estReq.base) { setEst(null); return; } estimate(estReq).then(e => { setEst(e); setEstErr(null); }).catch(e => { setEst(null); setEstErr(String(e.message || e)); }); }, [JSON.stringify(estReq), gflops]);
  const ds = datasets.find(d => d.name === f.dataset);
  const steps = f.maxSteps ? +f.maxSteps : ds ? Math.ceil((ds.count || 0) * (+f.epochs || 1) / Math.max(1, +f.batch || 1)) : null;
  const start = async () => {
    if (!f.dataset) return toast('Choose a dataset (create one in Studio → Datasets)', 'warn');
    if (f.method !== 'scratch' && !f.base) return toast('Choose a base model', 'warn');
    if (est && !est.fits && !await confirmDialog({ title: 'This may not fit in memory', message: `Estimated ${est.memoryGB.total} GB vs a ${est.budgetGB} GB budget. ${est.advice} Start anyway?`, ok: 'Start anyway' })) return;
    setBusy(true);
    try { const r = await startRun(req()); toast('Training started', 'ok'); onStarted(r.id); }
    catch (e) { toast(String(e.message || e), 'err', 7000); }
    finally { setBusy(false); }
  };
  const goModels = () => bus.emit('studio-tab', 'models');
  return html`<div class="card">
    <div class="card-title"><${Icon} name="flask" />New training run${onCancel && html`<span class="grow"></span><button class="ibtn sm" onClick=${onCancel} aria-label="Close"><${Icon} name="x" /></button>`}</div>
    <div class="field"><label>Method</label>
      <div class="chips">${Object.entries(METHODS).map(([k, m]) => html`<button class=${'chip' + (f.method === k ? ' on' : '')} onClick=${() => set('method', k)}>${m.label}</button>`)}</div>
      <div class="help">${METHODS[f.method].help}</div></div>
    ${f.method === 'scratch' ? html`<div class="field"><label>Model size</label><${Seg} block value=${f.size} onChange=${v => set('size', v)} options=${Object.entries(SCRATCH).map(([k, s]) => ({ value: k, label: s.label.split(' · ')[0] }))} />
        <div class="help">${SCRATCH[f.size].label}: ${SCRATCH[f.size].num_hidden_layers} layers, width ${SCRATCH[f.size].hidden_size}. A byte-level BPE tokenizer is trained on your text first.</div></div>`
      : html`<div class="field"><label>Base model</label>
        ${trainable.length ? html`<select class="input select" value=${f.base} onChange=${e => set('base', e.target.value)}>${trainable.map(m => html`<option value=${m.ref}>${m.name}${m.params ? ' · ' + m.params : ''}</option>`)}</select>`
          : html`<${Banner} icon="download">No trainable models yet. <button class="btn sm" style="margin-left:6px" onClick=${goModels}>Get one in Models</button> (Trainable models section: safetensors weights).<//>`}</div>
        <div class="field"><label>Tuning</label><${Seg} block value=${f.tuning} onChange=${v => set('tuning', v)} options=${[{ value: 'lora', label: 'LoRA' }, { value: 'qlora', label: 'QLoRA (4-bit)' }, { value: 'full', label: 'Full' }]} />
          <div class="help">${f.tuning === 'lora' ? 'Small adapter matrices on top of frozen 16-bit weights. Fast and light.' : f.tuning === 'qlora' ? 'Base weights in 4-bit NF4: about 3× less memory, for bigger models.' : 'Updates every weight. Best quality, needs ~16 bytes per parameter.'}</div></div>`}
    <div class="field"><label>Dataset</label>
      ${okSets.length ? html`<select class="input select" value=${f.dataset} onChange=${e => set('dataset', e.target.value)}>${okSets.map(d => html`<option value=${d.name}>${d.name} · ${d.type || 'sft'} · ${d.count ?? 0} rows</option>`)}</select>`
        : html`<${Banner} icon="dataset">No ${DATA_FOR[f.method].join('/')} datasets. <button class="btn sm" style="margin-left:6px" onClick=${() => bus.emit('studio-tab', 'datasets')}>Create one</button><//>`}</div>
    <div class="form-grid">
      <div class="field"><label>Epochs</label><input class="input" type="number" min="0.1" step="0.1" value=${f.epochs} onInput=${e => set('epochs', e.target.value)} /></div>
      <div class="field"><label>Max steps</label><input class="input" type="number" min="0" placeholder="auto" value=${f.maxSteps || ''} onInput=${e => set('maxSteps', e.target.value)} /></div>
      <div class="field"><label>Batch (sequences/step)</label><input class="input" type="number" min="1" value=${f.batch} onInput=${e => set('batch', e.target.value)} /></div>
      <div class="field"><label>Learning rate</label><input class="input" type="number" step="any" placeholder=${f.method === 'scratch' ? '1e-3' : f.tuning === 'full' ? '2e-5' : '2e-4'} value=${f.lr || ''} onInput=${e => set('lr', e.target.value)} /></div>
      <div class="field"><label>Sequence length</label><input class="input" type="number" min="16" placeholder=${f.method === 'scratch' || f.method === 'pretrain' ? '512' : '1024'} value=${f.seqLen || ''} onInput=${e => set('seqLen', e.target.value)} /></div>
      ${f.method !== 'scratch' && f.tuning !== 'full' && html`<div class="field"><label>LoRA rank / alpha</label><div class="row"><input class="input" type="number" min="1" value=${f.rank} onInput=${e => { set('rank', e.target.value); set('alpha', 2 * e.target.value); }} /><input class="input" type="number" min="1" value=${f.alpha} onInput=${e => set('alpha', e.target.value)} /></div></div>`}
      ${f.method === 'dpo' && html`<div class="field"><label>β (DPO strength)</label><input class="input" type="number" step="0.01" value=${f.beta} onInput=${e => set('beta', e.target.value)} /></div>`}
      ${f.method === 'grpo' && html`<div class="field"><label>Group size</label><input class="input" type="number" min="2" value=${f.group} onInput=${e => set('group', e.target.value)} /></div>
        <div class="field"><label>Max new tokens</label><input class="input" type="number" min="8" value=${f.maxNew} onInput=${e => set('maxNew', e.target.value)} /></div>
        <div class="field"><label>KL β</label><input class="input" type="number" step="0.01" value=${f.beta} onInput=${e => set('beta', e.target.value)} /></div>`}
    </div>
    ${f.method === 'grpo' && html`<div class="field"><label>Reward</label>
      <div class="row wrap"><${Toggle} on=${f.customReward} onChange=${v => set('customReward', v)} label="Custom JavaScript" /></div>
      ${f.customReward ? html`<textarea class="input textarea mono" rows="9" value=${f.rewardCode} onInput=${e => set('rewardCode', e.target.value)}></textarea><div class="help">Runs in the app's sandbox (no network, no file access). Combine built-ins with +, e.g. numeric+format, when not using custom code.</div>`
        : html`<select class="input select" value=${f.reward} onChange=${e => set('reward', e.target.value)}>${Object.entries(REWARDS).map(([k, r]) => html`<option value=${k}>${r.label}</option>`)}<option value="numeric+format">Numeric + format</option></select><div class="help">${REWARDS[f.reward]?.describe || 'Sum of the selected rewards.'}</div>`}</div>`}
    <button class="btn ghost sm" onClick=${() => setAdv(!adv)}><${Icon} name=${adv ? 'chevronDown' : 'chevronRight'} />Advanced</button>
    ${adv && html`<div class="form-grid" style="margin-top:10px">
      <div class="field"><label>Run name</label><input class="input" placeholder="auto" value=${f.name} onInput=${e => set('name', e.target.value)} /></div>
      <div class="field"><label>Warmup steps</label><input class="input" type="number" placeholder="5%" value=${f.warmup} onInput=${e => set('warmup', e.target.value)} /></div>
      <div class="field"><label>Weight decay</label><input class="input" type="number" step="any" placeholder=${f.tuning === 'full' ? '0.01' : '0'} value=${f.wd} onInput=${e => set('wd', e.target.value)} /></div>
      <div class="field"><label>Checkpoint every</label><input class="input" type="number" placeholder="auto" value=${f.saveEvery || ''} onInput=${e => set('saveEvery', e.target.value)} /></div>
      ${f.method === 'scratch' && html`<div class="field"><label>Vocabulary size</label><input class="input" type="number" placeholder=${SCRATCH[f.size].vocab} value=${f.vocabSize || ''} onInput=${e => set('vocabSize', e.target.value)} /></div>`}
      ${f.method === 'grpo' && html`<div class="field"><label>Sampling temperature</label><input class="input" type="number" step="0.05" value=${f.temperature} onInput=${e => set('temperature', e.target.value)} /></div>`}
      ${f.method !== 'scratch' && f.tuning !== 'full' && html`<div class="field" style="grid-column:1/-1"><label>LoRA target modules</label><div class="chips">${TARGETS.map(t => html`<button class=${'chip sm' + (f.targets.includes(t) ? ' on' : '')} onClick=${() => set('targets', f.targets.includes(t) ? f.targets.filter(x => x !== t) : [...f.targets, t])}>${t}_proj</button>`)}</div></div>`}
      ${f.method === 'sft' && html`<div class="field" style="grid-column:1/-1"><${Toggle} on=${f.completionOnly} onChange=${v => set('completionOnly', v)} label="Train on assistant replies only" /></div>`}
    </div>`}
    <div class="section-title" style="margin-top:14px"><${Icon} name="gauge" size=${14} />Estimate</div>
    ${estErr ? html`<div class="small err">${estErr}</div>` : est ? html`<${Estimate} est=${est} steps=${steps} />` : html`<div class="small dim">Pick a model and dataset to see memory and time.</div>`}
    <div class="row wrap" style="margin-top:12px">
      <button class="btn primary grow" disabled=${busy || (!trainable.length && f.method !== 'scratch') || !okSets.length} onClick=${start}>${busy ? html`<div class="spinner"></div>` : html`<${Icon} name="play" />Start training`}</button>
      <button class="btn" onClick=${() => bus.emit('studio-tab', 'offload')}><${Icon} name="rocket" />Offload instead</button></div>
  </div>`;
}

function Estimate({ est, steps }) {
  const m = est.memoryGB;
  const parts = [['Weights', m.weights, 'var(--accent)'], ['Optimizer', m.optimizer, '#f2b24c'], ['Activations', m.activations, '#3fd6a4'], ['KV cache', m.cache, '#4fb3ff']];
  const scale = Math.max(m.total, est.budgetGB);
  const [b, setB] = useState(false);
  return html`<div class="estimate">
      <div class="stat"><div class="stat-k">Memory</div><div class=${'stat-v ' + (est.fits ? '' : 'err')}>${m.total} GB</div></div>
      <div class="stat"><div class="stat-k">Trainable</div><div class="stat-v">${fmtNum(est.trainable)}</div></div>
      <div class="stat"><div class="stat-k">Per step</div><div class="stat-v">~${fmtDuration(est.secondsPerStep)}</div></div>
      <div class="stat"><div class="stat-k">Total</div><div class="stat-v">${steps ? '~' + fmtDuration(steps * est.secondsPerStep) : '—'}</div></div></div>
    <div class="meter" style="margin-top:10px">${parts.map(([, v, c]) => html`<div style=${`width:${(v / scale) * 100}%;background:${c}`}></div>`)}</div>
    <div class="legend" style="margin-top:6px">${parts.map(([k, v, c]) => html`<span><i style=${`background:${c}`}></i>${k} ${v} GB</span>`)}<span>Budget ${est.budgetGB} GB</span></div>
    <div class="help" style="margin-top:6px">${est.advice} ${est.measured ? `Speed measured on this GPU (${est.gflopsAssumed} GFLOPS).` : html`Speed is a guess. <button class="btn ghost sm" disabled=${b} onClick=${async () => { setB(true); try { const r = await benchmark(); toast(`GPU: ${Math.round(r.gflops)} GFLOPS`, 'ok'); } catch (e) { toast(e.message, 'err'); } setB(false); }}>${b ? 'Measuring…' : 'Measure GPU speed'}</button>`}</div>`;
}

function RunDetail({ id, back }) {
  const { runs, live: allLive, active } = useStore(runsStore);
  const run = runs.find(r => r.id === id);
  const l = allLive[id] || { metrics: [], evals: [], samples: [], rollouts: [], warns: [] };
  useEffect(() => { if (!isLive(run?.state) || !l.metrics.length) readMetrics(id); }, [id]);
  const [exporting, setExporting] = useState(null);
  if (!run) return null;
  const st = l.status || {};
  const last = l.last || l.metrics.at(-1);
  const running = active === id && isLive(run.state);
  const series = useMemo(() => {
    const loss = [{ name: 'loss', points: l.metrics.filter(m => Number.isFinite(m.loss)).map(m => [m.step, m.loss]) }];
    if (l.evals.length) loss.push({ name: 'val loss', points: l.evals.map(e => [e.step, e.val_loss]) });
    return loss;
  }, [l.metrics.length, l.evals.length]);
  const extra = run.method === 'grpo' ? [{ name: 'reward', points: l.metrics.map(m => [m.step, m.reward]) }] : run.method === 'dpo' ? [{ name: 'margin', points: l.metrics.map(m => [m.step, m.reward_margin]) }, { name: 'accuracy', points: l.metrics.map(m => [m.step, m.reward_acc]) }] : null;
  const doExport = async (what, opts = {}) => {
    setExporting(what + (opts.ggufType || ''));
    try { const r = await exportRun(id, what, opts); toast(`Saved to ${r.dir}`, 'ok', 5000); }
    catch (e) { toast(String(e.message || e), 'err', 7000); }
    finally { setExporting(null); }
  };
  const progress = run.total ? (last?.step ?? run.step) / run.total : 0;
  return html`<div class="page">
    <div class="run-head"><button class="ibtn" onClick=${back} aria-label="Back"><${Icon} name="chevronLeft" /></button>
      <div class="grow" style="min-width:0"><div style="font-weight:700" class="ellipsis">${run.name}</div>
        <div class="small dim">${METHODS[run.method]?.label}${run.method !== 'scratch' ? ' · ' + run.tuning.toUpperCase() : ''} · ${run.baseName} · ${run.dataset}</div></div>
      <span class=${'tag ' + (STATE_TAG[run.state] || '')}>${run.state}</span>
      <button class="ibtn" aria-label="More" onClick=${(e) => openMenu(e.currentTarget, [
        { text: 'Open folder in Hub', icon: 'folder', onClick: () => openInHub(run.dir) },
        { text: 'Run config', icon: 'file', onClick: () => openFileInEditor(run.dir + '/run.json') },
        { sep: true },
        { text: 'Delete run', icon: 'trash', danger: true, disabled: running, onClick: async () => { if (await confirmDialog({ title: 'Delete this run?', message: 'Checkpoints, metrics and samples are removed. Exported models stay.', ok: 'Delete', danger: true })) { await deleteRun(id); back(); } } },
      ])}><${Icon} name="more" /></button></div>
    ${run.state === 'error' && html`<${Banner} kind="err" icon="alert">${run.error || run.statusText}<//>`}
    ${run.state === 'interrupted' && html`<${Banner} kind="warn" icon="pause">${run.statusText}<//>`}
    ${l.warns?.length > 0 && html`<${Banner} kind="warn" icon="alert">${l.warns.at(-1)}<//>`}
    <div class="card">
      <div class="row" style="margin-bottom:8px"><b class="grow">${running ? (st.text || 'Training') : run.statusText || run.state}</b>
        ${running ? html`<button class="btn sm" onClick=${() => stopRun(id, { pause: true })}><${Icon} name="pause" />Pause</button><button class="btn sm danger" onClick=${() => stopRun(id)}><${Icon} name="stop" />Stop</button>`
          : ['paused', 'stopped', 'interrupted', 'error'].includes(run.state) && run.step < (run.total || Infinity) ? html`<button class="btn sm primary" disabled=${!!active} onClick=${() => resumeRun(id).catch(e => toast(e.message, 'err'))}><${Icon} name="play" />Resume</button>` : ''}</div>
      <${Progress} value=${st.state === 'preparing' && st.progress != null ? st.progress : progress} indet=${st.state === 'preparing' && st.progress == null} />
      <div class="stats" style="margin-top:10px">
        <div class="stat"><div class="stat-k">Step</div><div class="stat-v">${last?.step ?? run.step ?? 0}<span class="small dim">/${run.total || '?'}</span></div></div>
        <div class="stat"><div class="stat-k">${run.method === 'grpo' ? 'Reward' : 'Loss'}</div><div class="stat-v">${run.method === 'grpo' ? (last?.reward?.toFixed(3) ?? '—') : (last?.loss?.toFixed(4) ?? run.loss?.toFixed(4) ?? '—')}</div></div>
        ${l.evals.length > 0 && html`<div class="stat"><div class="stat-k">Val loss</div><div class="stat-v">${l.evals.at(-1).val_loss.toFixed(4)}</div></div>`}
        <div class="stat"><div class="stat-k">Tokens/s</div><div class="stat-v">${last?.tps ? Math.round(last.tps) : '—'}</div></div>
        ${running && last?.eta != null && html`<div class="stat"><div class="stat-k">Left</div><div class="stat-v">${fmtDuration(last.eta)}</div></div>`}
        <div class="stat"><div class="stat-k">LR</div><div class="stat-v">${last?.lr ? last.lr.toExponential(1) : '—'}</div></div>
      </div>
      ${running && html`<div class="help" style="margin-top:8px">Keep the app open and the screen on: iOS pauses web apps in the background. If it's interrupted, resume from the last checkpoint.</div>`}
    </div>
    <div class="section-title">${run.method === 'grpo' ? 'Objective' : 'Loss'}</div>
    <div class="card"><${LineChart} series=${series} height=${190} /></div>
    ${extra && html`<div class="section-title">${run.method === 'grpo' ? 'Mean reward' : 'Preference margin'}</div><div class="card"><${LineChart} series=${extra} height=${150} /></div>`}
    ${l.metrics.length > 2 && html`<div class="section-title">Gradient norm · learning rate</div><div class="card"><${LineChart} series=${[{ name: 'grad norm', points: l.metrics.map(m => [m.step, m.gnorm]) }, { name: 'lr ×1000', points: l.metrics.map(m => [m.step, m.lr * 1000]) }]} height=${130} /></div>`}
    ${l.rollouts.length > 0 && html`<div class="section-title">Latest rollouts</div><div class="card">${l.rollouts.slice(-1).map(r => html`<div class="small dim" style="margin-bottom:6px">Step ${r.step}: ${r.prompt}</div>${r.completions.map(c => html`<div class="sample" style="margin-bottom:6px"><span class="tag ${c.reward > 0 ? 'ok' : ''}">reward ${(+c.reward).toFixed(2)}</span> ${c.text}</div>`)}`)}</div>`}
    ${l.samples.length > 0 && html`<div class="section-title">Samples</div><div class="card">${l.samples.slice(-4).reverse().map(s => html`<div class="small dim">Step ${s.step}</div><div class="sample" style="margin:4px 0 10px">${s.text || '(empty)'}</div>`)}</div>`}
    ${!running && run.step > 0 && html`<${TryIt} id=${id} />`}
    ${!running && run.step > 0 && html`<div class="section-title">Export</div><div class="card">
      <div class="small dim" style="margin-bottom:10px">Exports go to your Hub (models/llm or models/adapters) and show up in Studio → Models, ready to chat with or to use as the Agent's model.</div>
      <div class="row wrap">
        ${run.tuning !== 'full' && run.method !== 'scratch' && html`<button class="btn" disabled=${!!exporting} onClick=${() => doExport('adapter')}>${exporting === 'adapter' ? html`<div class="spinner"></div>` : html`<${Icon} name="layers" />`}LoRA adapter</button>`}
        <button class="btn" disabled=${!!exporting} onClick=${() => doExport('merged', { name: run.name })}>${exporting === 'merged' ? html`<div class="spinner"></div>` : html`<${Icon} name="cpu" />`}Merged model</button>
        <button class="btn" disabled=${!!exporting} onClick=${() => doExport('gguf', { name: run.name, ggufType: 'q8_0' })}>${exporting === 'ggufq8_0' ? html`<div class="spinner"></div>` : html`<${Icon} name="zap" />`}GGUF q8_0</button>
        <button class="btn" disabled=${!!exporting} onClick=${() => doExport('gguf', { name: run.name + '-f16', ggufType: 'f16' })}>${exporting === 'gguff16' ? html`<div class="spinner"></div>` : html`<${Icon} name="zap" />`}GGUF f16</button>
      </div>
      ${exporting && l.export && html`<div style="margin-top:10px"><${Progress} value=${l.export.progress || 0} /><div class="small dim" style="margin-top:4px">${l.export.text}</div></div>`}
      ${run.exports && html`<div class="kv" style="margin-top:10px">${Object.entries(run.exports).map(([k, v]) => html`<span>${k}</span><span class="mono small">${v}</span>`)}</div>`}
      <div class="help" style="margin-top:8px">GGUF runs fastest for chat (llama.cpp). The merged model keeps full precision and can be trained further. Adapters are PEFT-compatible for use with transformers/Unsloth on a PC.</div>
    </div>`}
  </div>`;
}

function TryIt({ id }) {
  const [q, setQ] = useState('');
  const [a, setA] = useState('');
  const [busy, setBusy] = useState(false);
  const ask = async () => {
    if (!q.trim()) return;
    setBusy(true); setA('');
    try { const r = await chatWithRun(id, [{ role: 'user', content: q }], { onToken: (t) => setA(x => x + t), maxTokens: 256 }); setA(r.text); }
    catch (e) { setA('Error: ' + (e.message || e)); }
    setBusy(false);
  };
  return html`<div class="section-title">Try it</div><div class="card">
    <div class="row"><input class="input grow" placeholder="Ask the trained model…" value=${q} onInput=${e => setQ(e.target.value)} onKeyDown=${e => e.key === 'Enter' && ask()} />
      <button class="btn primary" disabled=${busy} onClick=${ask} aria-label="Ask">${busy ? html`<div class="spinner"></div>` : html`<${Icon} name="send" />`}</button></div>
    ${a && html`<div class="sample" style="margin-top:10px">${a}</div>`}</div>`;
}
