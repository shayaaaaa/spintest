// Studio → Offload: run bigger trainings on a real GPU. Same generated Unsloth script for Google Colab, Hugging Face
// Jobs, RunPod/Modal and a companion PC; results come back into the Hub as GGUF models.
import { html, useState, useEffect, useRef } from '../../../vendor/preact.mjs';
import { useStore } from '../../core/store.js';
import { Icon } from '../icons.js';
import { Seg, Progress, Banner, toast, confirmDialog, openSheet, copyText } from '../kit.js';
import { modelsStore } from '../../models/registry.js';
import { listDatasets } from '../../studio/datasets.js';
import { settings, setSetting, getSecret, setSecret } from '../../core/settings.js';
import { download, relTime } from '../../core/util.js';
import { GGUF_QUANTS, HF_FLAVORS, bundleFiles, colabNotebook, bundleZip, trainScript, companionScript, hfJobStart, hfJobStatus, hfJobLogs, hfJobCancel,
  companionHealth, companionStart, companionStatus, companionLog, companionFiles, companionCancel, companionImportGGUF, offloadStore, loadOffloadJobs, saveOffloadJob, deleteOffloadJob } from '../../forge/offload.js';
import { METHODS } from '../../forge/jobs.js';
import { TRAIN_CATALOG } from '../../models/catalog.js';

const TARGETS = [
  { id: 'colab', label: 'Colab', icon: 'book', blurb: 'Free T4 GPU in Google Colab. Download a notebook, open it in Colab, Run all.' },
  { id: 'hf', label: 'HF Jobs', icon: 'cloud', blurb: 'Hugging Face runs it on a GPU you pick and pushes the result to your account. Needs a PRO/Team account and a write token.' },
  { id: 'pod', label: 'RunPod / Modal', icon: 'rocket', blurb: 'A zip with train.py, data, run.sh and modal_app.py for any CUDA machine.' },
  { id: 'pc', label: 'Companion PC', icon: 'monitor', blurb: 'Run a small server on your own computer with a GPU and send jobs from here.' },
];
const BIG_BASES = ['unsloth/Llama-3.2-3B-Instruct', 'unsloth/Meta-Llama-3.1-8B-Instruct-bnb-4bit', 'unsloth/Qwen3-8B-unsloth-bnb-4bit', 'unsloth/Qwen3-14B-unsloth-bnb-4bit', 'unsloth/gemma-3-4b-it', 'unsloth/mistral-7b-instruct-v0.3-bnb-4bit'];

export function OffloadPanel() {
  const { local } = useStore(modelsStore);
  const [datasets, setDatasets] = useState([]);
  useEffect(() => { listDatasets().then(setDatasets); loadOffloadJobs(); }, []);
  const [target, setTarget] = useState('colab');
  const [f, setF] = useState({ method: 'sft', tuning: 'qlora', base: 'unsloth/Meta-Llama-3.1-8B-Instruct-bnb-4bit', dataset: '', epochs: 1, maxSteps: 0, lr: '', batch: 2, gradAccum: 4, seqLen: 2048, rank: 16, gguf: 'q4_k_m', reward: 'exact', group: 8, maxNew: 512, name: '' });
  const set = (k, v) => setF(s => ({ ...s, [k]: v }));
  useEffect(() => { if (!f.dataset && datasets[0]) set('dataset', datasets[0].name); }, [datasets.length]);
  const cfg = () => ({ ...f, lr: +f.lr || undefined, maxSteps: +f.maxSteps || undefined, epochs: +f.epochs, batch: +f.batch, gradAccum: +f.gradAccum, seqLen: +f.seqLen, rank: +f.rank, alpha: 2 * f.rank, group: +f.group, maxNew: +f.maxNew, name: (f.name || `${f.base.split('/').pop()}-${f.method}`).replace(/[^\w.-]+/g, '-') });
  const files = async () => { if (!f.dataset) throw new Error('Choose a dataset'); return bundleFiles(cfg(), { dataset: f.dataset }); };
  const suggestions = [...new Set([...local.filter(m => m.source?.repo).map(m => m.source.repo), ...TRAIN_CATALOG.map(m => m.repo), ...BIG_BASES])];
  const T = TARGETS.find(t => t.id === target);
  return html`<div class="page">
    <${Banner} icon="rocket">Your phone trains small models well. For 3B–70B models, long sequences or many epochs, send the job to a real GPU. The result comes back as a GGUF you can chat with offline.<//>
    <div class="section-title">Where</div>
    <${Seg} block value=${target} onChange=${setTarget} options=${TARGETS.map(t => ({ value: t.id, label: t.label }))} />
    <div class="help" style="margin:6px 2px 12px">${T.blurb}</div>
    <div class="card">
      <div class="card-title"><${Icon} name="sliders" />Job</div>
      <div class="field"><label>Method</label><div class="chips">${Object.entries(METHODS).filter(([k]) => k !== 'scratch').map(([k, m]) => html`<button class=${'chip' + (f.method === k ? ' on' : '')} onClick=${() => set('method', k)}>${m.label}</button>`)}</div></div>
      <div class="field"><label>Base model (Hugging Face repo)</label><input class="input mono" list="offload-bases" value=${f.base} onInput=${e => set('base', e.target.value.trim())} />
        <datalist id="offload-bases">${suggestions.map(s => html`<option value=${s} />`)}</datalist>
        <div class="help">Unsloth's pre-quantized repos (…-bnb-4bit) download faster. Gated models (Llama) need an HF token with access.</div></div>
      <div class="field"><label>Tuning</label><${Seg} block value=${f.tuning} onChange=${v => set('tuning', v)} options=${[{ value: 'lora', label: 'LoRA' }, { value: 'qlora', label: 'QLoRA' }, { value: 'full', label: 'Full' }]} /></div>
      <div class="field"><label>Dataset</label><select class="input select" value=${f.dataset} onChange=${e => set('dataset', e.target.value)}>${datasets.map(d => html`<option value=${d.name}>${d.name} · ${d.type || 'sft'} · ${d.count ?? 0} rows</option>`)}</select></div>
      <div class="form-grid">
        <div class="field"><label>Epochs</label><input class="input" type="number" step="0.1" value=${f.epochs} onInput=${e => set('epochs', e.target.value)} /></div>
        <div class="field"><label>Max steps</label><input class="input" type="number" placeholder="auto" value=${f.maxSteps || ''} onInput=${e => set('maxSteps', e.target.value)} /></div>
        <div class="field"><label>Batch × accum</label><div class="row"><input class="input" type="number" value=${f.batch} onInput=${e => set('batch', e.target.value)} /><input class="input" type="number" value=${f.gradAccum} onInput=${e => set('gradAccum', e.target.value)} /></div></div>
        <div class="field"><label>Learning rate</label><input class="input" type="number" step="any" placeholder="2e-4" value=${f.lr} onInput=${e => set('lr', e.target.value)} /></div>
        <div class="field"><label>Max length</label><input class="input" type="number" value=${f.seqLen} onInput=${e => set('seqLen', e.target.value)} /></div>
        <div class="field"><label>LoRA rank</label><input class="input" type="number" value=${f.rank} onInput=${e => set('rank', e.target.value)} /></div>
        <div class="field"><label>GGUF quant</label><select class="input select" value=${f.gguf} onChange=${e => set('gguf', e.target.value)}>${GGUF_QUANTS.map(q => html`<option value=${q}>${q}</option>`)}</select></div>
        ${f.method === 'grpo' && html`<div class="field"><label>Reward</label><select class="input select" value=${f.reward} onChange=${e => set('reward', e.target.value)}>${['exact', 'contains', 'numeric', 'math', 'regex', 'format', 'json', 'length', 'numeric+format'].map(r => html`<option value=${r}>${r}</option>`)}</select></div>
          <div class="field"><label>Group size</label><input class="input" type="number" value=${f.group} onInput=${e => set('group', e.target.value)} /></div>`}
      </div>
      <button class="btn ghost sm" onClick=${() => openSheet({ title: 'train.py', wide: true }, () => html`<pre class="sample" style="max-height:70vh">${trainScript(cfg())}</pre><button class="btn block" onClick=${() => copyText(trainScript(cfg()))}><${Icon} name="copy" />Copy</button>`)}><${Icon} name="code" />Preview train.py</button>
    </div>
    ${target === 'colab' && html`<${ColabTarget} cfg=${cfg} files=${files} />`}
    ${target === 'hf' && html`<${HFTarget} cfg=${cfg} files=${files} />`}
    ${target === 'pod' && html`<${PodTarget} cfg=${cfg} files=${files} />`}
    ${target === 'pc' && html`<${PCTarget} cfg=${cfg} files=${files} />`}
    <${JobHistory} />
  </div>`;
}

function ColabTarget({ cfg, files }) {
  const go = async () => {
    try { const c = cfg(); const nb = colabNotebook(c, await files()); download(`${c.name}.ipynb`, nb, 'application/x-ipynb+json'); await saveOffloadJob({ target: 'colab', name: c.name, cfg: c, state: 'exported' }); toast('Notebook saved. Open Colab → File → Upload notebook.', 'ok', 6000); }
    catch (e) { toast(e.message, 'err'); }
  };
  return html`<div class="card"><ol class="step-list">
      <li>Download the notebook (your dataset is embedded in it).</li>
      <li>Open <b>colab.research.google.com</b> → File → Upload notebook. Choose a T4 GPU runtime.</li>
      <li>Runtime → Run all. At the end the GGUF downloads to your phone; import it in Studio → Models → Import file.</li></ol>
    <div class="row wrap"><button class="btn primary grow" onClick=${go}><${Icon} name="download" />Download notebook</button>
      <a class="btn" href="https://colab.research.google.com/" target="_blank" rel="noopener"><${Icon} name="external" />Open Colab</a></div></div>`;
}

function PodTarget({ cfg, files }) {
  const go = async () => {
    try { const c = cfg(); const blob = await bundleZip(c, await files()); download(`${c.name}-job.zip`, blob, 'application/zip'); await saveOffloadJob({ target: 'pod', name: c.name, cfg: c, state: 'exported' }); toast('Job zip saved', 'ok'); }
    catch (e) { toast(e.message, 'err'); }
  };
  return html`<div class="card"><ol class="step-list">
      <li>Download the job zip: train.py, your data, run.sh (RunPod or any CUDA box) and modal_app.py (Modal).</li>
      <li>RunPod: start a PyTorch pod, upload and unzip, run <code>bash run.sh</code>. Modal: <code>modal run modal_app.py</code>.</li>
      <li>Set <code>HF_TOKEN</code> and <code>OUTPUT_REPO</code> to push results to Hugging Face, then download them in Studio → Models.</li></ol>
    <button class="btn primary block" onClick=${go}><${Icon} name="download" />Download job zip</button></div>`;
}

function HFTarget({ cfg, files }) {
  const [flavor, setFlavor] = useState('a10g-small');
  const [timeout, setTimeoutV] = useState('6h');
  const [busy, setBusy] = useState(null);
  const hasToken = !!getSecret('hf_token');
  const go = async () => {
    setBusy('Preparing…');
    try {
      const c = cfg();
      const r = await hfJobStart(c, await files(), { flavor, timeout, onProgress: setBusy });
      await saveOffloadJob({ target: 'hf', name: c.name, cfg: c, state: 'RUNNING', hf: r });
      toast('Job started on Hugging Face', 'ok');
    } catch (e) { toast(String(e.message || e), 'err', 9000); }
    setBusy(null);
  };
  return html`<div class="card">
    ${!hasToken && html`<${Banner} kind="warn" icon="key">Add a Hugging Face token with write access in Settings → Keys.<//>`}
    <div class="field"><label>GPU</label><select class="input select" value=${flavor} onChange=${e => setFlavor(e.target.value)}>${HF_FLAVORS.map(x => html`<option value=${x.id}>${x.label} — ${x.note}</option>`)}</select></div>
    <div class="field"><label>Time limit</label><input class="input" value=${timeout} onInput=${e => setTimeoutV(e.target.value)} placeholder="6h" /><div class="help">Billed per minute by Hugging Face. The job stops at this limit.</div></div>
    <div class="help" style="margin-bottom:10px">Your dataset is uploaded to a private dataset repo in your account; results (LoRA, merged, GGUF) are pushed to a private model repo with the job's name.</div>
    <button class="btn primary block" disabled=${!!busy || !hasToken} onClick=${go}>${busy ? html`<div class="spinner"></div> ${busy}` : html`<${Icon} name="play" />Start on Hugging Face`}</button></div>`;
}

function PCTarget({ cfg, files }) {
  const s = useStore(settings, x => x.offload || {});
  const [url, setUrl] = useState(s.companionUrl || '');
  const [token, setToken] = useState(getSecret('companion_token') || '');
  const [health, setHealth] = useState(null);
  const [busy, setBusy] = useState(false);
  const save = () => { setSetting('offload.companionUrl', url); setSecret('companion_token', token); };
  const test = async () => { setBusy(true); try { save(); setHealth(await companionHealth(url, token)); } catch (e) { setHealth({ error: e.message }); } setBusy(false); };
  const go = async () => {
    setBusy(true);
    try { save(); const c = cfg(); const r = await companionStart(url, token, await files()); await saveOffloadJob({ target: 'pc', name: c.name, cfg: c, state: 'running', pc: { url, id: r.id } }); toast('Job sent to your computer', 'ok'); }
    catch (e) { toast(String(e.message || e), 'err', 8000); }
    setBusy(false);
  };
  return html`<div class="card">
    <ol class="step-list">
      <li><button class="btn sm" onClick=${() => download('ai_agent_companion.py', companionScript(), 'text/x-python')}><${Icon} name="download" />Get ai_agent_companion.py</button> and copy it to a computer with an NVIDIA GPU.</li>
      <li>Run <code>pip install fastapi uvicorn python-multipart unsloth trl datasets</code> then <code>python ai_agent_companion.py</code>. It prints a token.</li>
      <li>Expose it over HTTPS, e.g. <code>cloudflared tunnel --url http://localhost:8765</code> or Tailscale Funnel, and paste the https address below.</li></ol>
    <div class="field"><label>Companion URL</label><input class="input mono" placeholder="https://….trycloudflare.com" value=${url} onInput=${e => setUrl(e.target.value.trim())} /></div>
    <div class="field"><label>Token</label><input class="input mono" type="password" value=${token} onInput=${e => setToken(e.target.value.trim())} /></div>
    ${health && (health.error ? html`<div class="small err" style="margin-bottom:8px">${health.error}</div>` : html`<div class="small ok" style="margin-bottom:8px">Connected · GPU: ${health.gpu}</div>`)}
    <div class="row wrap"><button class="btn" disabled=${busy || !url} onClick=${test}>Test connection</button>
      <button class="btn primary grow" disabled=${busy || !url || !token} onClick=${go}><${Icon} name="send" />Send job</button></div></div>`;
}

function JobHistory() {
  const { jobs } = useStore(offloadStore);
  if (!jobs.length) return null;
  return html`<div class="section-title">Offload jobs</div>${jobs.map(j => html`<${JobCard} key=${j.id} job=${j} />`)}`;
}

function JobCard({ job }) {
  const [log, setLog] = useState('');
  const [files, setFiles] = useState(null);
  const [state, setState] = useState(job.state);
  const [imp, setImp] = useState(null);
  const off = useRef(0);
  const running = ['RUNNING', 'running', 'QUEUED', 'STARTING'].includes(state);
  useEffect(() => {
    if (!running) return;
    let stop = false; const ac = new AbortController();
    const poll = async () => {
      while (!stop) {
        try {
          if (job.target === 'hf') {
            const s = await hfJobStatus(job.hf.ns, job.hf.id); setState(s.stage);
            if (!['RUNNING', 'QUEUED', 'STARTING'].includes(s.stage)) { await saveOffloadJob({ ...job, state: s.stage, message: s.message }); break; }
          } else if (job.target === 'pc') {
            const t = await companionLog(job.pc.url, getSecret('companion_token'), job.pc.id, off.current);
            if (t) { off.current += new TextEncoder().encode(t).length; setLog(l => (l + t).slice(-20000)); }
            const s = await companionStatus(job.pc.url, getSecret('companion_token'), job.pc.id); setState(s.state);
            if (s.state !== 'running') { await saveOffloadJob({ ...job, state: s.state }); setFiles(await companionFiles(job.pc.url, getSecret('companion_token'), job.pc.id)); break; }
          }
        } catch (e) { setLog(l => l + `\n[status error] ${e.message}`); }
        await new Promise(r => setTimeout(r, 8000));
      }
    };
    if (job.target === 'hf') hfJobLogs(job.hf.ns, job.hf.id, (line) => setLog(l => (l + line + '\n').slice(-20000)), ac.signal).catch(() => {});
    poll();
    return () => { stop = true; ac.abort(); };
  }, [job.id, running]);
  useEffect(() => { if (job.target === 'pc' && state === 'done' && !files) companionFiles(job.pc.url, getSecret('companion_token'), job.pc.id).then(setFiles).catch(() => {}); }, [state]);
  const cancel = async () => { if (!await confirmDialog({ title: 'Cancel this job?', ok: 'Cancel job', danger: true })) return; if (job.target === 'hf') await hfJobCancel(job.hf.ns, job.hf.id); else if (job.target === 'pc') await companionCancel(job.pc.url, getSecret('companion_token'), job.pc.id); };
  const importHF = async () => {
    try {
      const { listFiles } = await import('../../models/hf.js');
      const ggufs = (await listFiles(job.hf.outRepo)).filter(x => x.path.endsWith('.gguf'));
      if (!ggufs.length) return toast('No GGUF in the output repo yet', 'warn');
      const { installGGUF } = await import('../../models/registry.js');
      await installGGUF({ repo: job.hf.outRepo, file: ggufs[0].path, name: job.name });
      toast('Downloading into Studio → Models', 'ok');
    } catch (e) { toast(e.message, 'err', 7000); }
  };
  const done = ['COMPLETED', 'done'].includes(state);
  return html`<div class="mcard"><div class="mi"><${Icon} name=${TARGETS.find(t => t.id === job.target)?.icon || 'rocket'} /></div>
    <div class="grow" style="min-width:0"><div class="mt">${job.name}<span class=${'tag ' + (done ? 'ok' : running ? 'accent' : /ERROR|error|CANCELED/.test(state) ? 'err' : '')}>${state}</span></div>
      <div class="ms">${TARGETS.find(t => t.id === job.target)?.label} · ${job.cfg?.base} · ${relTime(job.created)}${job.hf ? ` · ${job.hf.flavor}` : ''}</div>
      ${log && html`<pre class="sample" style="margin-top:8px;max-height:160px">${log.split('\n').slice(-40).join('\n')}</pre>`}
      ${files?.length > 0 && html`<div class="small" style="margin-top:8px">${files.filter(x => x.path.endsWith('.gguf')).map(x => html`<div class="row"><span class="grow mono ellipsis">${x.path}</span>
        <button class="btn sm" disabled=${!!imp} onClick=${async () => { setImp(0); try { await companionImportGGUF(job.pc.url, getSecret('companion_token'), job.pc.id, x, job.name, setImp); toast('Imported into Studio → Models', 'ok'); } catch (e) { toast(e.message, 'err'); } setImp(null); }}>Import</button></div>`)}</div>`}
      ${imp != null && html`<div style="margin-top:6px"><${Progress} value=${imp} /></div>`}
      <div class="acts">
        ${running && (job.target === 'hf' || job.target === 'pc') && html`<button class="btn sm danger" onClick=${cancel}>Cancel</button>`}
        ${job.target === 'hf' && html`<a class="btn sm" href=${`https://huggingface.co/${job.hf.outRepo}`} target="_blank" rel="noopener"><${Icon} name="external" />Output repo</a>`}
        ${job.target === 'hf' && done && html`<button class="btn sm primary" onClick=${importHF}><${Icon} name="download" />Download GGUF</button>`}
        <button class="btn sm" onClick=${() => deleteOffloadJob(job.id)}><${Icon} name="trash" /></button></div></div></div>`;
}
