// Progress of the automatic first-run setup: a slim bar above the tab bar (tap for the checklist) and a list
// reused in Settings → Storage & offline.
import { html } from '../../vendor/preact.mjs';
import { useStore } from '../core/store.js';
import { setupStore } from '../core/setup.js';
import { Icon } from './icons.js';
import { Progress, openSheet } from './kit.js';

const finished = (x) => x.state === 'done' || x.state === 'skipped';
export function overallProgress(steps) { return steps.length ? steps.reduce((a, x) => a + (finished(x) ? 1 : x.progress || 0), 0) / steps.length : 1; }

export function SetupBar() {
  const s = useStore(setupStore);
  if (!s.running) return null;
  const doneN = s.steps.filter(finished).length;
  const cur = s.steps.find(x => x.state === 'running' && x.id !== 'model') || s.steps.find(x => x.state === 'running');
  const pct = overallProgress(s.steps);
  return html`<button class="setup-bar" onClick=${openSetupSheet} aria-label="Setup progress">
    <div class="spinner" style="width:14px;height:14px;border-width:2px;flex:none"></div>
    <div class="grow ellipsis"><b>Setting up</b> · ${doneN}/${s.steps.length}${cur ? ` · ${cur.label}` : ''}${cur?.text ? `: ${cur.text}` : ''}</div>
    <span class="setup-pct">${Math.round(pct * 100)}%</span>
    <div class="setup-bar-progress" style=${`width:${pct * 100}%`}></div></button>`;
}

export function SetupList() {
  const s = useStore(setupStore);
  if (!s.steps.length) return null;
  return html`<div class="setup-list">${s.steps.map(x => html`<div class="setup-row">
    <span class=${'setup-ico ' + x.state}>${x.state === 'running' ? html`<div class="spinner" style="width:15px;height:15px;border-width:2px"></div>` : html`<${Icon} name=${finished(x) ? 'checkCircle' : x.state === 'error' ? 'alert' : 'clock'} size=${17} />`}</span>
    <div class="grow" style="min-width:0"><div class="setup-label">${x.label} <span class="small dim">${x.size}</span></div>
      ${x.state === 'running' && html`<div style="margin-top:5px"><${Progress} value=${x.progress || 0} indet=${!x.progress} /></div>`}
      ${x.text && html`<div class=${'small ' + (x.state === 'error' ? 'err' : 'dim')} style="margin-top:3px">${x.state === 'error' ? `Will retry next launch: ${x.text}` : x.text}</div>`}</div></div>`)}</div>`;
}

export function openSetupSheet() {
  openSheet({ title: 'Setting up Ai Agent' }, () => html`<div class="small dim" style="margin-bottom:10px">Everything installs once, in the background, so the app then works fully offline. You can keep using it meanwhile; if the app closes, setup continues where it stopped the next time it opens.</div><${SetupList} />`);
}
