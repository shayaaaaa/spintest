// Studio → Models: downloads, on-device library, recommended catalog, WebLLM, voice/vision/embeddings, HF search.
import { html, useState, useEffect } from '../../../vendor/preact.mjs';
import { useStore } from '../../core/store.js';
import { Icon } from '../icons.js';
import { bus } from '../../core/bus.js';
import { Seg, Progress, toast, confirmDialog, openMenu, Banner, openSheet, Empty } from '../kit.js';
import { downloads, pause, resume, cancel, restorePending } from '../../models/downloader.js';
import { modelsStore, refreshModels, installGGUF, installMLC, installONNX, installSafetensors, deleteModel, engineLabel, unloadLocal, getEngine } from '../../models/registry.js';
import { GGUF_CATALOG, ONNX_CATALOG, TRAIN_CATALOG, memNeedGB, fitRating } from '../../models/catalog.js';
import { searchModels, listFiles } from '../../models/hf.js';
import { fmtBytes, fmtDuration } from '../../core/util.js';
import { settings, setSetting } from '../../core/settings.js';
import { env, memoryBudgetGB } from '../../core/platform.js';

const ROLE_LABELS = { agent: 'Agent', chat: 'Chat', code: 'Code', complete: 'Autocomplete', subagent: 'Subagents' };

function Downloads() {
  const { jobs } = useStore(downloads);
  useEffect(() => { restorePending(); }, []);
  if (!jobs.length) return null;
  return html`<div class="section-title"><${Icon} name="download" size=${14} />Downloads</div>${jobs.map(j => {
    const pct = j.total ? j.loaded / j.total : 0;
    const eta = j.speed > 0 ? (j.total - j.loaded) / j.speed : null;
    return html`<div class="dl"><div class="dl-row"><b class="grow ellipsis">${j.name}</b>
      ${j.status === 'downloading' && html`<button class="ibtn sm" onClick=${() => pause(j.id)} aria-label="Pause"><${Icon} name="pause" /></button>`}
      ${['paused', 'error', 'queued'].includes(j.status) && html`<button class="ibtn sm" onClick=${() => resume(j.id)} aria-label="Resume"><${Icon} name="play" /></button>`}
      ${j.status !== 'done' && html`<button class="ibtn sm" onClick=${async () => { if (await confirmDialog({ title: 'Cancel download?', message: 'Downloaded parts are deleted.', ok: 'Cancel download', danger: true })) cancel(j.id); }} aria-label="Cancel"><${Icon} name="x" /></button>`}</div>
      <${Progress} value=${pct} indet=${j.status === 'downloading' && !j.total} />
      <div class="small dim" style="margin-top:6px">${j.status === 'done' ? html`<span class="ok">Done · ${fmtBytes(j.total)}</span>` : j.status === 'error' ? html`<span class="err">${j.error}</span>` : `${fmtBytes(j.loaded)} of ${fmtBytes(j.total)} · ${j.status}${j.speed ? ` · ${fmtBytes(j.speed)}/s` : ''}${eta ? ` · ${fmtDuration(eta)} left` : ''}`}</div></div>`;
  })}
  <div class="help" style="margin:-2px 4px 8px">Keep the app open while downloading; iOS pauses web apps in the background. Paused downloads resume where they stopped.</div>`;
}

function useRoles() { return useStore(settings, s => s.models || {}); }

function LocalModels() {
  const { local, loaded, status } = useStore(modelsStore);
  const roles = useRoles();
  useEffect(() => { refreshModels(); }, []);
  if (!local.length) return html`<div class="card small dim">Nothing downloaded yet. Pick a model below: they run fully offline on your phone.</div>`;
  return html`${local.map(m => {
    const usedAs = Object.entries(roles).filter(([, v]) => v === m.ref).map(([k]) => ROLE_LABELS[k] || k);
    const isLLM = m.kind === 'llm' && m.status === 'ready' && m.engine !== 'forge' || (m.engine === 'forge' && m.status === 'ready');
    return html`<div class="mcard"><div class="mi"><${Icon} name=${{ llm: 'cpu', vision: 'image', speech: 'mic', tts: 'speaker', embeddings: 'database', adapters: 'layers' }[m.kind] || 'cpu'} /></div>
      <div class="grow" style="min-width:0"><div class="mt">${m.name || m.id}<span class="tag">${engineLabel(m.engine)}</span>${m.status !== 'ready' ? html`<span class="tag warn">${m.status}</span>` : ''}${loaded === m.ref ? html`<span class="tag ok">loaded</span>` : ''}${usedAs.map(u => html`<span class="tag accent">${u}</span>`)}${m.trainable ? html`<span class="tag">trainable</span>` : ''}</div>
        <div class="ms">${m.kind}${m.params ? ' · ' + m.params : ''}${m.bytes ? ' · ' + fmtBytes(m.bytes) : ''}${m.source?.repo ? ' · ' + m.source.repo : ''}</div>
        ${status?.ref === m.ref && status.state === 'loading' && html`<div style="margin-top:8px"><${Progress} value=${status.progress || 0} indet=${!status.progress} /><div class="small dim" style="margin-top:4px">${status.text}</div></div>`}
        ${status?.ref === m.ref && status.state === 'error' && html`<div class="small err" style="margin-top:6px">${status.text}</div>`}
        <div class="acts">
          ${isLLM && html`<button class="btn sm" onClick=${(e) => openMenu(e.currentTarget, Object.entries(ROLE_LABELS).map(([k, l]) => ({ text: `Use for ${l}`, selected: roles[k] === m.ref, onClick: () => setSetting('models.' + k, roles[k] === m.ref ? '' : m.ref) })))}><${Icon} name="check" />Use for…</button>`}
          ${isLLM && (loaded === m.ref ? html`<button class="btn sm" onClick=${() => unloadLocal()}>Unload</button>` : html`<button class="btn sm" onClick=${() => getEngine(m.ref).then(() => toast(`${m.name} is loaded`, 'ok')).catch(e => toast(e.message, 'err', 6000))}><${Icon} name="play" />Load</button>`)}
          ${m.kind === 'embeddings' && html`<button class="btn sm" onClick=${() => setSetting('models.embed', 'onnx:' + m.source.repo)}>${settings.get().models?.embed === 'onnx:' + m.source?.repo ? 'Default for search' : 'Use for search'}</button>`}
          ${m.kind === 'speech' && html`<button class="btn sm" onClick=${() => setSetting('models.stt', 'onnx:' + m.source.repo)}>Use for dictation</button>`}
          <button class="btn sm danger" onClick=${async () => { if (await confirmDialog({ title: `Delete ${m.name || m.id}?`, message: `Frees ${fmtBytes(m.bytes || 0)}. You can download it again later.`, ok: 'Delete', danger: true })) { await deleteModel(m.ref); toast('Deleted'); } }}><${Icon} name="trash" /></button>
        </div></div></div>`;
  })}`;
}

function FitTag({ sizeGB, context, params }) {
  const f = fitRating(memNeedGB(sizeGB, context, params), memoryBudgetGB());
  return html`<span class=${'tag ' + f.cls}>${f.label}</span>`;
}

// Other panels can ask for a catalog section (e.g. Train → "Get one" opens "For training").
let pendingCatalogTab = null;
bus.on('models-tab', (t) => { pendingCatalogTab = t; });

function Catalog() {
  const { local } = useStore(modelsStore);
  const have = (pred) => local.some(pred);
  const [tab, setTab] = useState(() => { const t = pendingCatalogTab; pendingCatalogTab = null; return t || 'recommended'; });
  const [mlc, setMlc] = useState(null);
  useEffect(() => bus.on('models-tab', (t) => setTab(t)), []);
  useEffect(() => { if (tab === 'webllm' && !mlc) import('../../models/local/webllm.js').then(m => m.webllmCatalog()).then(setMlc).catch(e => toast(e.message, 'err')); }, [tab]);
  const dlBtn = (onClick, done) => done ? html`<span class="tag ok">Downloaded</span>` : html`<button class="btn sm primary" onClick=${() => onClick().then(() => toast('Download started', 'ok')).catch(e => toast(String(e.message || e), 'err', 6000))}><${Icon} name="download" />Download</button>`;
  return html`<div class="section-title"><${Icon} name="sparkles" size=${14} />Get models</div>
    <${Seg} value=${tab} onChange=${setTab} options=${[{ value: 'recommended', label: 'Recommended' }, { value: 'voice', label: 'Voice & vision' }, { value: 'train', label: 'For training' }, { value: 'webllm', label: 'WebLLM' }, { value: 'search', label: 'Search HF' }]} />
    <div style="margin-top:10px">
    ${tab === 'recommended' && GGUF_CATALOG.map(m => html`<div class="mcard"><div class="mi"><${Icon} name=${m.tags.includes('vision') ? 'image' : m.tags.includes('code') ? 'code' : 'cpu'} /></div><div class="grow">
      <div class="mt">${m.name}<${FitTag} sizeGB=${m.sizeGB} context=${m.context} params=${m.params} />${m.tags.includes('recommended') ? html`<span class="tag accent">Start here</span>` : ''}</div>
      <div class="ms">${m.sizeGB} GB · ${m.params} · llama.cpp (GGUF)</div><div class="mb">${m.blurb}</div>
      <div class="acts">${dlBtn(() => installGGUF(m), have(x => x.source?.repo === m.repo && x.gguf?.files?.includes(m.file)))}</div></div></div>`)}
    ${tab === 'voice' && ONNX_CATALOG.map(m => html`<div class="mcard"><div class="mi"><${Icon} name=${{ speech: 'mic', tts: 'speaker', embeddings: 'database', vision: 'image', llm: 'cpu' }[m.kind]} /></div><div class="grow">
      <div class="mt">${m.name}<span class="tag">${m.kind}</span></div><div class="ms">${m.sizeGB < 1 ? Math.round(m.sizeGB * 1000) + ' MB' : m.sizeGB + ' GB'} · ONNX</div><div class="mb">${m.blurb}</div>
      <div class="acts">${dlBtn(() => installONNX(m), have(x => x.source?.repo === m.repo && x.status === 'ready'))}</div></div></div>`)}
    ${tab === 'train' && html`<${Banner} icon="flask">Training bases are full-precision safetensors models (bigger downloads). They can be fine-tuned, trained further with RL, and chatted with after training.<//>${TRAIN_CATALOG.map(m => html`<div class="mcard" style="margin-top:8px"><div class="mi"><${Icon} name="flask" /></div><div class="grow">
      <div class="mt">${m.name}</div><div class="ms">${(m.params / 1e6).toFixed(0)}M parameters · ~${fmtBytes(m.params * 2)} (bf16)</div><div class="mb">${m.blurb}</div>
      <div class="acts">${dlBtn(() => installSafetensors(m), have(x => x.source?.repo === m.repo))}</div></div></div>`)}`}
    ${tab === 'webllm' && (mlc ? html`<${Banner} icon="zap">WebLLM runs MLC-compiled models on the GPU. Fast, but only for these prebuilt models. Pick q4f16 versions on iPhone.<//>${mlc.filter(r => /q4f16/.test(r.model_id)).map(r => html`<div class="mcard" style="margin-top:8px"><div class="mi"><${Icon} name="zap" /></div><div class="grow">
      <div class="mt">${r.model_id.replace(/-MLC$/, '')}<${FitTag} sizeGB=${r.vram_required_MB / 1000 * 0.8} context=${r.context} /></div><div class="ms">~${(r.vram_required_MB / 1000).toFixed(1)} GB GPU memory · context ${r.context}</div>
      <div class="acts">${dlBtn(() => installMLC(r), have(x => x.mlc?.model_id === r.model_id))}</div></div></div>`)}` : html`<div class="spinner"></div>`)}
    ${tab === 'search' && html`<${HFSearch} />`}
    </div>`;
}

function HFSearch() {
  const [q, setQ] = useState('');
  const [kind, setKind] = useState('gguf');
  const [res, setRes] = useState(null);
  const run = async () => { setRes('busy'); try { setRes(await searchModels(q, kind === 'gguf' ? { filter: 'gguf' } : kind === 'onnx' ? { library: 'transformers.js' } : { filter: 'safetensors' })); } catch (e) { toast(e.message, 'err'); setRes(null); } };
  return html`<div class="row"><input class="input" placeholder="Search Hugging Face, e.g. qwen coder" value=${q} onInput=${e => setQ(e.target.value)} onKeyDown=${e => e.key === 'Enter' && run()} /><button class="btn primary" onClick=${run}><${Icon} name="search" /></button></div>
    <div style="margin-top:8px"><${Seg} value=${kind} onChange=${setKind} options=${[{ value: 'gguf', label: 'GGUF (chat)' }, { value: 'safetensors', label: 'Safetensors (train)' }, { value: 'onnx', label: 'ONNX' }]} /></div>
    ${res === 'busy' ? html`<div style="margin-top:12px"><${Progress} indet /></div>` : res && html`<div class="list" style="margin-top:10px">${res.length ? res.map(m => html`<button class="li" onClick=${() => openRepo(m.id, kind)}><span class="li-icon"><${Icon} name="package" /></span><div class="li-main"><div class="li-title">${m.id}</div><div class="li-sub">${(m.downloads || 0).toLocaleString()} downloads · ${m.likes || 0} likes${m.gated ? ' · gated' : ''}</div></div><${Icon} name="chevronRight" /></button>`) : html`<div class="li dim">No results</div>`}</div>`}`;
}

function openRepo(repo, kind) {
  openSheet({ title: repo }, (close) => html`<${RepoFiles} repo=${repo} kind=${kind} close=${close} />`);
}
function RepoFiles({ repo, kind, close }) {
  const [files, setFiles] = useState(null);
  const [mmproj, setMmproj] = useState('');
  useEffect(() => { listFiles(repo).then(setFiles).catch(e => { toast(e.message, 'err', 6000); setFiles([]); }); }, [repo]);
  if (!files) return html`<${Progress} indet />`;
  if (kind === 'safetensors') return html`<div class="small dim">${files.filter(f => f.path.endsWith('.safetensors')).length} weight files · ${fmtBytes(files.filter(f => f.path.endsWith('.safetensors')).reduce((a, f) => a + f.size, 0))}</div>
    <button class="btn primary block" style="margin-top:12px" onClick=${() => installSafetensors({ repo }).then(() => { toast('Download started', 'ok'); close(); }).catch(e => toast(e.message, 'err', 6000))}><${Icon} name="download" />Download for training</button>`;
  if (kind === 'onnx') return html`<button class="btn primary block" onClick=${() => { const k = prompt('Kind: llm, embeddings, speech, tts, vision', 'llm'); if (k) installONNX({ repo, kind: k }).then(() => toast('Downloaded', 'ok')).catch(e => toast(e.message, 'err')); close(); }}><${Icon} name="download" />Download (ONNX)</button>`;
  const ggufs = files.filter(f => f.path.endsWith('.gguf') && !/mmproj/i.test(f.path) && !/-0000[2-9]-of-/.test(f.path));
  const projs = files.filter(f => /mmproj.*\.gguf$/i.test(f.path));
  return html`${projs.length > 0 && html`<div class="field"><label>Vision projector (optional, lets the model see images)</label><select class="select" value=${mmproj} onChange=${e => setMmproj(e.target.value)}><option value="">None</option>${projs.map(p => html`<option value=${p.path}>${p.path} (${fmtBytes(p.size)})</option>`)}</select></div>`}
    <div class="list">${ggufs.length ? ggufs.map(f => { const gb = f.size / 1e9; const fit = fitRating(memNeedGB(gb, 4096), memoryBudgetGB()); return html`<button class="li" onClick=${() => installGGUF({ repo, file: f.path, mmproj: mmproj || undefined, name: f.path.replace(/\.gguf$/, '').split('/').pop() }).then(() => { toast('Download started', 'ok'); close(); }).catch(e => toast(e.message, 'err', 6000))}>
      <span class="li-icon"><${Icon} name="download" /></span><div class="li-main"><div class="li-title">${f.path}</div><div class="li-sub">${fmtBytes(f.size)}</div></div><span class=${'tag ' + fit.cls}>${fit.label}</span></button>`; }) : html`<div class="li dim">No GGUF files in this repo</div>`}</div>
    <div class="help" style="margin-top:8px">Q4_K_M is the usual sweet spot. Q8_0 is higher quality but twice the size.</div>`;
}

export function ModelsPanel() {
  const webgpu = useStore(env, s => s.webgpu);
  return html`<div class="page">
    ${webgpu === false && html`<${Banner} kind="warn" icon="alert">WebGPU isn't available here, so models run on the CPU (slower). On iPhone, use Safari on iOS 26 or later.<//>`}
    <${Downloads} />
    <div class="section-title"><${Icon} name="cpu" size=${14} />On this phone</div>
    <${LocalModels} />
    <${Catalog} />
  </div>`;
}
