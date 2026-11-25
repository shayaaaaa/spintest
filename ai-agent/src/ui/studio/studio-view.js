// Studio tab: models, training (fine-tune / from scratch / RL), datasets, evaluation, GPU offload.
import { html, useState, useEffect } from '../../../vendor/preact.mjs';
import { Icon } from '../icons.js';
import { bus } from '../../core/bus.js';
import { ModelsPanel } from './models-panel.js';
import { DatasetsPanel } from './datasets-panel.js';

const TABS = [
  { id: 'models', label: 'Models', icon: 'cpu' },
  { id: 'train', label: 'Train', icon: 'flask' },
  { id: 'datasets', label: 'Datasets', icon: 'dataset' },
  { id: 'eval', label: 'Evaluate', icon: 'gauge' },
  { id: 'offload', label: 'Offload', icon: 'rocket' },
];

const lazy = {
  train: () => import('./train-panel.js').then(m => m.TrainPanel),
  eval: () => import('./eval-panel.js').then(m => m.EvalPanel),
  offload: () => import('./offload-panel.js').then(m => m.OffloadPanel),
};

function Lazy({ id }) {
  const [C, setC] = useState(null);
  const [err, setErr] = useState(null);
  useEffect(() => { setC(null); lazy[id]().then(c => setC(() => c)).catch(setErr); }, [id]);
  if (err) return html`<div class="empty"><${Icon} name="alert" /><h3>Couldn't load</h3><div class="small">${String(err.message || err)}</div></div>`;
  return C ? html`<${C} />` : html`<div class="center" style="padding:40px"><div class="spinner"></div></div>`;
}

export function StudioView() {
  const [tab, setTab] = useState('models');
  useEffect(() => bus.on('studio-tab', (t) => setTab(t)), []);
  return html`<div class="studio">
    <div class="phead"><div class="phead-title"><${Icon} name="flask" />Studio</div></div>
    <div class="subtabs">${TABS.map(t => html`<button class=${'subtab' + (tab === t.id ? ' on' : '')} onClick=${() => setTab(t.id)}><${Icon} name=${t.icon} />${t.label}</button>`)}</div>
    <div class="studio-scroll">
      ${tab === 'models' && html`<${ModelsPanel} />`}
      ${tab === 'datasets' && html`<${DatasetsPanel} />`}
      ${lazy[tab] && html`<${Lazy} id=${tab} key=${tab} />`}
    </div>
  </div>`;
}
