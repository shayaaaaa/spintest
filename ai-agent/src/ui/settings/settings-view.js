// Settings sheet: models & keys, agent, permissions, web, voice, appearance, connectors (MCP), storage, about.
import { html, useState, useEffect } from '../../../vendor/preact.mjs';
import { useStore } from '../../core/store.js';
import { Icon } from '../icons.js';
import { openSheet, Toggle, Seg, toast, confirmDialog, promptDialog, Banner, Progress, copyText } from '../kit.js';
import { settings, secrets, permissions, setSetting, setSecret } from '../../core/settings.js';
import { PROVIDERS } from '../../models/providers.js';
import { modelLabel, fetchCloudModels } from '../../models/registry.js';
import { openModelPicker } from '../pickers.js';
import { MODES, removeRule, addRule } from '../../agent/permissions.js';
import { env, refreshStorage } from '../../core/platform.js';
import { fmtBytes, download } from '../../core/util.js';
import * as vfs from '../../core/vfs.js';
import { bus } from '../../core/bus.js';
import { systemVoices, speak } from '../../models/speech.js';
import { linuxStore } from '../../runtimes/linux.js';
import { setupStore, runSetup } from '../../core/setup.js';
import { SetupList } from '../setup-bar.js';

const SECTIONS = [
  { id: 'models', label: 'Models & keys', icon: 'cpu' },
  { id: 'agent', label: 'Agent', icon: 'terminal' },
  { id: 'permissions', label: 'Permissions', icon: 'shield' },
  { id: 'web', label: 'Web access', icon: 'globe' },
  { id: 'voice', label: 'Voice', icon: 'mic' },
  { id: 'appearance', label: 'Appearance & layout', icon: 'sun' },
  { id: 'connectors', label: 'Connectors (MCP)', icon: 'puzzle' },
  { id: 'storage', label: 'Storage & offline', icon: 'database' },
  { id: 'about', label: 'About', icon: 'info' },
];

export function openSettings(section) {
  openSheet({ title: 'Settings', wide: true }, () => html`<${SettingsBody} initial=${section} />`);
}

function SettingsBody({ initial }) {
  const [sec, setSec] = useState(initial || null);
  const two = useStore(env, s => s.width >= 760);
  const current = sec || (two ? 'models' : null);
  const nav = html`<div class="list">${SECTIONS.map(s => html`<button class="li" style=${current === s.id && two ? 'background:var(--bg-hover)' : ''} onClick=${() => setSec(s.id)}><span class="li-icon"><${Icon} name=${s.icon} /></span><div class="li-main"><div class="li-title">${s.label}</div></div><${Icon} name="chevronRight" size=${16} /></button>`)}</div>`;
  const body = current && html`<div>${!two && html`<button class="btn ghost sm" style="margin:-4px 0 8px -8px" onClick=${() => setSec(null)}><${Icon} name="chevronLeft" />All settings</button>`}
    <h3 style="margin:0 0 12px">${SECTIONS.find(s => s.id === current).label}</h3>${SECTION_VIEWS[current]()}</div>`;
  if (two) return html`<div style="display:grid;grid-template-columns:240px 1fr;gap:20px;align-items:start">${nav}${body}</div>`;
  return current ? body : nav;
}

const Row = ({ label, help, children }) => html`<div class="field"><div class="row"><label class="grow">${label}</label>${children}</div>${help && html`<div class="help">${help}</div>`}</div>`;

function ModelRole({ role, label, help }) {
  const v = useStore(settings, s => s.models?.[role] || '');
  return html`<div class="field"><label>${label}</label>
    <button class="btn" style="justify-content:space-between" onClick=${() => openModelPicker({ current: v, allowDefault: true, title: label, onPick: (r) => setSetting('models.' + role, r) })}><span class="ellipsis">${v ? modelLabel(v) : 'Automatic'}</span><${Icon} name="chevronDown" /></button>
    ${help && html`<div class="help">${help}</div>`}</div>`;
}

function KeyField({ pid }) {
  const p = PROVIDERS[pid];
  const val = useStore(secrets, s => s[p.secret] || '');
  const prov = useStore(settings, s => s.providers?.[pid] || {});
  const [show, setShow] = useState(false);
  const [testing, setTesting] = useState(false);
  const test = async () => {
    setTesting(true);
    try { const l = await fetchCloudModels(pid); toast(`${p.label}: key works, ${l.length} models available`, 'ok'); }
    catch (e) { toast(String(e.message || e), 'err', 6000); }
    finally { setTesting(false); }
  };
  return html`<div class="card" style="margin-bottom:10px">
    <div class="card-title">${p.label}${val && html`<span class="tag ok">key saved</span>`}<span class="spacer"></span>${p.keyUrl && html`<a class="small" href=${p.keyUrl} target="_blank" rel="noopener">Get a key</a>`}</div>
    ${p.custom && html`<div class="field"><label>Base URL (OpenAI-compatible, HTTPS)</label><input class="input mono" value=${prov.baseUrl || ''} placeholder="https://my-server.example.com/v1" onInput=${e => setSetting(`providers.${pid}.baseUrl`, e.target.value)} />
      <div class="help">Ollama / LM Studio on a PC work through an HTTPS tunnel (e.g. Cloudflare Tunnel), because the app is served over HTTPS.</div></div>
      <${Row} label="Enabled"><${Toggle} on=${!!prov.enabled} onChange=${v => setSetting(`providers.${pid}.enabled`, v)} /><//>`}
    <div class="row"><input class="input mono" type=${show ? 'text' : 'password'} autocomplete="off" placeholder="API key" value=${val} onInput=${e => setSecret(p.secret, e.target.value.trim())} />
      <button class="ibtn" onClick=${() => setShow(!show)} aria-label="Show key"><${Icon} name="eye" /></button>
      <button class="btn sm" disabled=${(!val && !p.custom) || testing} onClick=${test}>${testing ? html`<div class="spinner"></div>` : 'Test'}</button></div>
  </div>`;
}

const SECTION_VIEWS = {
  models: () => html`
    <${Banner} icon="lock">Keys are stored only on this phone (Hub/settings/secrets.json) and sent only to that provider. Cloud models are optional; everything works offline with downloaded models.<//>
    <div class="section-title">Default models</div>
    <${ModelRole} role="agent" label="Agent" help="Used by the Agent tab. Tool calling matters most: Qwen3 4B Instruct (on-device) or a Claude model." />
    <${ModelRole} role="chat" label="Chat" />
    <${ModelRole} role="code" label="Code assistant" />
    <${ModelRole} role="complete" label="Autocomplete (ghost text)" help="A small fast model, e.g. Qwen2.5 Coder 1.5B or Qwen3 0.6B." />
    <${ModelRole} role="subagent" label="Subagents" />
    <div class="section-title">Cloud providers</div>
    ${Object.keys(PROVIDERS).map(pid => html`<${KeyField} pid=${pid} key=${pid} />`)}
    <div class="section-title">Hugging Face</div>
    <${HFToken} />`,
  agent: () => html`<${AgentSettings} />`,
  permissions: () => html`<${PermSettings} />`,
  web: () => html`<${WebSettings} />`,
  voice: () => html`<${VoiceSettings} />`,
  appearance: () => html`<${Appearance} />`,
  connectors: () => html`<${Connectors} />`,
  storage: () => html`<${Storage} />`,
  about: () => html`<${About} />`,
};

function HFToken() {
  const val = useStore(secrets, s => s.hf_token || '');
  return html`<div class="field"><label>Access token (optional)</label><input class="input mono" type="password" value=${val} placeholder="hf_…" onInput=${e => setSecret('hf_token', e.target.value.trim())} />
    <div class="help">Needed only for gated models (accept the license on huggingface.co first) and for uploading datasets/adapters or running HF Jobs.</div></div>`;
}

function AgentSettings() {
  const a = useStore(settings, s => s.agent);
  const set = (k, v) => setSetting('agent.' + k, v);
  return html`
    <div class="field"><label>Default permission mode</label><${Seg} block value=${a.defaultMode || 'ask'} onChange=${v => set('defaultMode', v)} options=${MODES.map(m => ({ value: m.id, label: m.short }))} /><div class="help">${MODES.find(m => m.id === (a.defaultMode || 'ask')).hint}</div></div>
    <div class="field"><label>Thinking</label><${Seg} block value=${a.thinking || 'auto'} onChange=${v => set('thinking', v)} options=${[{ value: 'auto', label: 'Auto' }, { value: 'on', label: 'On' }, { value: 'off', label: 'Off (faster)' }]} /></div>
    <div class="field"><label>Effort (Claude models)</label><${Seg} block value=${a.effort || ''} onChange=${v => set('effort', v)} options=${[{ value: '', label: 'Default' }, { value: 'low', label: 'Low' }, { value: 'medium', label: 'Medium' }, { value: 'high', label: 'High' }, { value: 'xhigh', label: 'Max+' }]} /></div>
    <div class="field"><label>Tools</label><${Seg} block value=${a.toolProfile || 'auto'} onChange=${v => set('toolProfile', v)} options=${[{ value: 'auto', label: 'Auto' }, { value: 'full', label: 'All tools' }, { value: 'core', label: 'Core only' }]} /><div class="help">Auto gives small on-device models a smaller core tool set so they fit the context window.</div></div>
    <${Row} label=${`Max steps per request: ${a.maxTurns || 60}`}><input type="range" min="5" max="200" step="5" value=${a.maxTurns || 60} onInput=${e => set('maxTurns', Number(e.target.value))} style="max-width:180px" /><//>
    <${Row} label=${`Temperature (on-device): ${a.temperature ?? 0.6}`}><input type="range" min="0" max="1.5" step="0.05" value=${a.temperature ?? 0.6} onInput=${e => set('temperature', Number(e.target.value))} style="max-width:180px" /><//>
    <${Row} label=${`Max reply length (on-device): ${a.maxTokens || 2048} tokens`}><input type="range" min="256" max="8192" step="256" value=${a.maxTokens || 2048} onInput=${e => set('maxTokens', Number(e.target.value))} style="max-width:180px" /><//>
    <${Row} label="Auto-compact when the context is nearly full"><${Toggle} on=${a.autoCompact !== false} onChange=${v => set('autoCompact', v)} /><//>
    <${Row} label="Show thinking"><${Toggle} on=${a.showThinking !== false} onChange=${v => set('showThinking', v)} /><//>`;
}

function PermSettings() {
  const p = useStore(permissions);
  const list = (k, title, help) => html`<div class="section-title">${title}</div><div class="help" style="margin:-4px 4px 8px">${help}</div>
    <div class="list">${(p[k] || []).map(r => html`<div class="li"><span class="li-main mono small">${r}</span><button class="ibtn sm" onClick=${() => removeRule(k, r)} aria-label="Remove"><${Icon} name="x" /></button></div>`)}
    <button class="li" onClick=${async () => { const r = await promptDialog({ title: 'Add rule', label: 'Examples: Bash(npm test:*) · Edit(/workspace/app/**) · WebFetch(domain:github.com) · Read', mono: true }); if (r) addRule(k, r.trim()); }}><span class="li-icon"><${Icon} name="plus" /></span><span class="li-main">Add rule</span></button></div>`;
  return html`${list('allow', 'Allow', 'Run without asking.')}${list('ask', 'Always ask', 'Ask even in auto modes.')}${list('deny', 'Deny', 'Never allowed.')}`;
}

function WebSettings() {
  const w = useStore(settings, s => s.web);
  const [code, setCode] = useState('');
  useEffect(() => { fetch(new URL('../../../docs/proxy-worker.js', import.meta.url)).then(r => r.ok ? r.text() : '').then(setCode).catch(() => {}); }, []);
  return html`
    <div class="field"><label>How the agent reaches the web</label>
      <${Seg} block value=${w.mode} onChange=${v => setSetting('web.mode', v)} options=${[{ value: 'auto', label: 'Auto' }, { value: 'cloud', label: 'Cloud' }, { value: 'reader', label: 'Reader' }, { value: 'proxy', label: 'Proxy' }, { value: 'off', label: 'Off' }]} />
      <div class="help">${{ auto: "Claude models use their built-in web search; everything else uses the reader service (r.jina.ai), which turns pages into text. URLs you fetch are sent to that service.", cloud: 'Only cloud models with built-in search get web access.', reader: 'Always use the r.jina.ai reader/search service.', proxy: 'Send web requests through your own proxy (most private).', off: 'No web access.' }[w.mode]}</div></div>
    <${Row} label="Allow the reader service as a fallback"><${Toggle} on=${w.allowReader !== false} onChange=${v => setSetting('web.allowReader', v)} /><//>
    <div class="field"><label>Your proxy URL (optional)</label><input class="input mono" placeholder="https://my-proxy.username.workers.dev" value=${w.proxyUrl || ''} onInput=${e => setSetting('web.proxyUrl', e.target.value.trim())} />
      <div class="help">A free Cloudflare Worker works: create a Worker at dash.cloudflare.com, paste this code, deploy, and put its URL here. It also lets cloud APIs that block web apps work.</div>
      ${code && html`<button class="btn sm" style="margin-top:8px" onClick=${() => copyText(code)}><${Icon} name="copy" />Copy worker code</button>`}</div>`;
}

function VoiceSettings() {
  const st = useStore(settings, s => ({ stt: s.models?.stt || 'system', voice: s.chat?.voice || '', speak: !!s.chat?.speakReplies }));
  const [voices, setVoices] = useState(systemVoices());
  useEffect(() => { const f = () => setVoices(systemVoices()); speechSynthesis?.addEventListener?.('voiceschanged', f); return () => speechSynthesis?.removeEventListener?.('voiceschanged', f); }, []);
  return html`
    <div class="field"><label>Speech to text</label><${Seg} block value=${st.stt} onChange=${v => setSetting('models.stt', v)} options=${[{ value: 'system', label: 'iOS dictation' }, { value: 'onnx:onnx-community/whisper-base', label: 'Whisper base' }, { value: 'onnx:onnx-community/whisper-small', label: 'Whisper small' }]} />
      <div class="help">Whisper runs fully on the phone (downloads once, 80–250 MB).</div></div>
    <div class="field"><label>Voice for spoken replies</label><select class="select" value=${st.voice} onChange=${e => setSetting('chat.voice', e.target.value)}><option value="">Automatic (best available)</option>${voices.map(v => html`<option value=${v.id}>${v.name} (${v.lang})${v.local ? '' : ' · online'}</option>`)}</select>
      <div class="help">Tip: download Enhanced or Premium voices in iOS Settings → Accessibility → Spoken Content → Voices for natural offline speech.</div>
      <button class="btn sm" style="margin-top:8px" onClick=${() => speak('Hi! This is how I sound when I read replies to you.')}><${Icon} name="speaker" />Test voice</button></div>
    <${Row} label="Read chat replies aloud"><${Toggle} on=${st.speak} onChange=${v => setSetting('chat.speakReplies', v)} /><//>`;
}

function Appearance() {
  const s = useStore(settings, x => ({ theme: x.theme, accent: x.accent, layout: x.layout, fontSize: x.fontSize }));
  return html`
    <div class="field"><label>Theme</label><${Seg} block value=${s.theme} onChange=${v => setSetting('theme', v)} options=${[{ value: 'system', label: 'System' }, { value: 'dark', label: 'Dark' }, { value: 'light', label: 'Light' }]} /></div>
    <div class="field"><label>Accent</label><div class="row">${['iris', 'mint', 'amber', 'rose', 'sky'].map(a => html`<button class=${'chip' + (s.accent === a ? ' on' : '')} onClick=${() => setSetting('accent', a)}>${a}</button>`)}</div></div>
    <div class="field"><label>Layout when unfolded</label><${Seg} block value=${s.layout} onChange=${v => setSetting('layout', v)} options=${[{ value: 'adaptive', label: 'Two panes', icon: 'columns' }, { value: 'single', label: 'Single pane', icon: 'square' }]} />
      <div class="help">Two panes: each side shows a different tab (Agent + Code, Chat + Studio…). Drag the divider to resize; tap a pane, then a tab in the side rail to change it.</div></div>
    <${Row} label=${`Text size: ${s.fontSize}px`}><input type="range" min="13" max="19" value=${s.fontSize} onInput=${e => setSetting('fontSize', Number(e.target.value))} style="max-width:180px" /><//>`;
}

function Connectors() {
  const [cfg, setCfg] = useState(null);
  const load = () => vfs.readJSON('/settings/mcp.json', { servers: {} }).then(setCfg);
  useEffect(() => { load(); }, []);
  const save = async (next) => { await vfs.writeJSON('/settings/mcp.json', next); setCfg(next); const { resetMcp } = await import('../../agent/mcp.js'); resetMcp(); };
  const add = async () => {
    const url = await promptDialog({ title: 'Add MCP server', label: 'Server URL (Streamable HTTP endpoint)', placeholder: 'https://example.com/mcp', mono: true });
    if (!url) return;
    const name = (await promptDialog({ title: 'Name', value: new URL(url).hostname.split('.')[0] })) || 'server';
    const token = await promptDialog({ title: 'Auth token (optional)', placeholder: 'Leave empty if none', mono: true });
    await save({ servers: { ...cfg.servers, [name]: { url, enabled: true, ...(token ? { headers: { Authorization: 'Bearer ' + token } } : {}) } } });
  };
  if (!cfg) return null;
  return html`<${Banner}>MCP servers add tools to the agent when you're online. They need to allow requests from web apps (CORS), or go through your proxy (Settings → Web).<//>
    <div class="list" style="margin-top:12px">${Object.entries(cfg.servers).map(([n, s]) => html`<div class="li"><span class="li-icon"><${Icon} name="puzzle" /></span><div class="li-main"><div class="li-title">${n}</div><div class="li-sub">${s.url}</div></div>
      <${Toggle} on=${s.enabled !== false} onChange=${v => save({ servers: { ...cfg.servers, [n]: { ...s, enabled: v } } })} />
      <button class="ibtn sm" onClick=${() => { const next = { ...cfg.servers }; delete next[n]; save({ servers: next }); }} aria-label="Remove"><${Icon} name="trash" /></button></div>`)}
      <button class="li" onClick=${add}><span class="li-icon"><${Icon} name="plus" /></span><span class="li-main">Add server</span></button></div>`;
}

function Storage() {
  const e = useStore(env, s => ({ storage: s.storage }));
  const [cache, setCache] = useState(null);
  const [persisted, setPersisted] = useState(null);
  const [manifest, setManifest] = useState(null);
  useEffect(() => {
    refreshStorage();
    navigator.storage?.persisted?.().then(setPersisted);
    fetch(new URL('../../../asset-manifest.json', import.meta.url)).then(r => r.json()).then(setManifest).catch(() => {});
    const offs = [bus.on('cache-engines-progress', (d) => setCache(d)), bus.on('cache-engines-done', (d) => { setCache({ done: d.total, total: d.total, finished: true }); toast('Everything is available offline', 'ok'); })];
    return () => offs.forEach(f => f());
  }, []);
  const cacheEngines = async () => { const reg = await navigator.serviceWorker?.ready; reg?.active?.postMessage({ type: 'cache-engines' }); setCache({ done: 0, total: 1 }); };
  const exportHub = async () => {
    const { JSZip } = await import('../../../vendor/office.mjs');
    const z = new JSZip();
    toast('Packing your Hub (models are skipped)…');
    for await (const f of vfs.walk('/', { ignore: new Set(['models', 'runtimes', 'trash']) })) { if (f.path === '/settings/secrets.json') continue; z.file(f.path.slice(1), await vfs.getFile(f.path)); }
    download(`ai-agent-hub-${new Date().toISOString().slice(0, 10)}.zip`, await z.generateAsync({ type: 'blob' }));
  };
  const importHub = async () => {
    const inp = Object.assign(document.createElement('input'), { type: 'file', accept: '.zip' });
    inp.onchange = async () => {
      const { JSZip } = await import('../../../vendor/office.mjs');
      const z = await JSZip.loadAsync(inp.files[0]);
      let n = 0;
      for (const [name, entry] of Object.entries(z.files)) { if (entry.dir) continue; await vfs.write('/' + name, await entry.async('uint8array')); n++; }
      toast(`Imported ${n} files`, 'ok');
    };
    inp.click();
  };
  const { used, quota } = e.storage;
  return html`
    <div class="card"><div class="card-title">Storage</div>
      <div class="meter"><div style=${`width:${quota ? used / quota * 100 : 0}%;background:var(--accent)`}></div></div>
      <div class="small dim" style="margin-top:6px">${fmtBytes(used)} used of ${fmtBytes(quota)} available to Ai Agent</div>
      <div class="small" style="margin-top:6px">${persisted ? html`<span class="ok">✓ Storage is persistent</span>` : html`<span class="warn">Storage may be cleared by iOS if space runs low. Add the app to your Home Screen to keep it.</span>`}</div></div>
    <div class="card"><div class="card-title">Offline engines</div>
      <div class="small dim">The app itself (${manifest ? fmtBytes(manifest.bytes.core) : '…'}) is always cached. Engines (${manifest ? fmtBytes(manifest.bytes.engines) : '…'}: llama.cpp, WebLLM, ONNX, office, PDF, Linux) are cached when first used, or all at once here.</div>
      ${cache && !cache.finished ? html`<div style="margin-top:10px"><${Progress} value=${cache.done} max=${cache.total} /></div>` : html`<button class="btn" style="margin-top:10px" onClick=${cacheEngines}><${Icon} name="download" />${cache?.finished ? 'Refresh offline engines' : 'Make everything available offline'}</button>`}</div>
    <${AutoSetup} />
    <${Runtimes} />
    <div class="card"><div class="card-title">Back up</div>
      <div class="small dim">Export memory, skills, tools, agents, knowledge, datasets, chats, settings (without API keys) and projects as a .zip.</div>
      <div class="row" style="margin-top:10px"><button class="btn" onClick=${exportHub}><${Icon} name="download" />Export Hub</button><button class="btn" onClick=${importHub}><${Icon} name="upload" />Import</button></div></div>
    <div class="card"><div class="card-title" style="color:var(--err)">Danger zone</div>
      <button class="btn danger" onClick=${async () => { if (await confirmDialog({ title: 'Delete everything?', message: 'This erases the whole Hub on this phone: models, memory, projects, settings and keys.', ok: 'Erase', danger: true })) { await vfs.rm('/', {}).catch(async () => { for (const e of await vfs.list('/')) await vfs.rm(e.path); }); location.reload(); } }}><${Icon} name="trash" />Erase Hub</button></div>`;
}

function AutoSetup() {
  const s = useStore(setupStore);
  const auto = useStore(settings, x => x.setup?.auto !== false);
  const completed = useStore(settings, x => x.setup?.completed);
  return html`<div class="card"><div class="card-title">Automatic setup</div>
    <div class="small dim">On first launch Ai Agent installs everything it needs by itself: offline app files, the Linux VM (with its first boot), Python, ffmpeg, the search model and the Agent & Chat model. Anything missing is picked up on the next launch.</div>
    ${s.running ? html`<div style="margin-top:10px"><${SetupList} /></div>`
      : completed ? html`<div class="small ok" style="margin-top:8px">✓ Everything installed (${new Date(completed).toLocaleDateString()})</div>`
      : html`<div class="small warn" style="margin-top:8px">Not finished yet: it continues automatically when the app opens online.</div>`}
    <div class="row wrap" style="margin-top:10px;align-items:center"><${Toggle} on=${auto} onChange=${v => setSetting('setup.auto', v)} label="Install automatically" />
      ${!s.running && html`<button class="btn sm" onClick=${() => runSetup({ force: true })}><${Icon} name="refresh" />Install anything missing</button>`}</div></div>`;
}

// Downloadable runtimes kept in Hub/runtimes (each is fetched once, then works offline).
const RUNTIMES = [
  { id: 'pyodide', name: 'Python (Pyodide)', blurb: 'Python 3 with numpy, pandas, matplotlib… for the Python tool and terminal.', size: '~30 MB',
    install: async () => (await import('../../runtimes/python.js')).install() },
  { id: 'ffmpeg', name: 'ffmpeg', blurb: 'Audio/video conversion and editing for the Media tool.', size: '~32 MB',
    install: async () => (await import('../../agent/tools/media.js')).ensureFfmpeg() },
  { id: 'linux', name: 'Linux VM (Alpine)', blurb: 'A real Linux shell in the terminal: type linux, or linux <command>. The image ships with the app and installs automatically on first launch.', size: '49 MB',
    install: async () => { const L = await import('../../runtimes/linux.js'); await L.install(); await L.prepare(); } },
];
function Runtimes() {
  const [sizes, setSizes] = useState({});
  const [busy, setBusy] = useState(null);
  const lin = useStore(linuxStore);
  const net = useStore(settings, s => !!s.linux?.network);
  const [linuxReady, setLinuxReady] = useState(false);
  const load = async () => {
    const o = {}; for (const r of RUNTIMES) o[r.id] = await vfs.du('/runtimes/' + r.id).catch(() => ({ bytes: 0, files: 0 })); setSizes(o);
    setLinuxReady(await (await import('../../runtimes/linux.js')).isPrepared());
  };
  useEffect(() => { if (lin.state === 'ready' || lin.state === 'off') load(); }, [lin.state]);
  useEffect(() => { load(); }, []);
  const act = async (r, what) => {
    setBusy(r.id);
    try {
      if (what === 'install') { await r.install(); toast(`${r.name} is ready offline`, 'ok'); }
      else {
        // Removing Linux also stops the automatic first-launch install from bringing it back.
        if (r.id === 'linux') { await (await import('../../runtimes/linux.js')).shutdown(); setSetting('linux.autoInstall', false); }
        await vfs.rm('/runtimes/' + r.id); toast(`${r.name} removed`);
      }
    } catch (e) { toast(String(e.message || e), 'err', 7000); }
    setBusy(null); load();
  };
  const importIso = () => {
    const inp = Object.assign(document.createElement('input'), { type: 'file', accept: '.iso,application/x-iso9660-image' });
    inp.onchange = async () => {
      const f = inp.files[0]; if (!f) return;
      setBusy('linux');
      try { await (await import('../../runtimes/linux.js')).importISO(f); toast('Linux image imported', 'ok'); } catch (e) { toast(String(e.message || e), 'err', 7000); }
      setBusy(null); load();
    };
    inp.click();
  };
  return html`<div class="card"><div class="card-title">Runtimes</div>
    ${RUNTIMES.map(r => { const have = sizes[r.id]?.bytes > 0; return html`<div class="row" style="padding:8px 0;border-top:1px solid var(--border);align-items:flex-start">
      <div class="grow" style="min-width:0"><div style="font-weight:600">${r.name}${have ? html` <span class="tag ok">${fmtBytes(sizes[r.id].bytes)}</span>` : ''}${r.id === 'linux' && have ? html` <span class=${'tag ' + (linuxReady ? 'ok' : 'warn')}>${linuxReady ? 'starts in ~1 s' : 'first start ~1 min'}</span>` : ''}</div>
        <div class="small dim">${r.blurb}${have ? '' : ` Download ${r.size}.`}</div>
        ${r.id === 'linux' && (lin.state === 'downloading' || lin.state === 'booting') && html`<div style="margin-top:6px"><${Progress} value=${lin.progress || 0} indet=${lin.state === 'booting'} /><div class="small dim">${lin.text}</div></div>`}
        ${r.id === 'linux' && have && html`<div style="margin-top:6px"><${Toggle} on=${net} onChange=${v => setSetting('linux.network', v)} label="Network inside the VM (experimental, HTTP via the browser)" /></div>`}</div>
      ${busy === r.id ? html`<div class="spinner"></div>` : have ? html`<button class="btn sm" onClick=${() => act(r, 'remove')}>Remove</button>` : html`<div class="col" style="gap:6px;align-items:stretch"><button class="btn sm primary" onClick=${() => act(r, 'install')}>Install</button>
        ${r.id === 'linux' && html`<button class="btn sm" onClick=${importIso}>Import ISO</button>`}</div>`}
    </div>`; })}</div>`;
}

function About() {
  const e = useStore(env);
  const [ver, setVer] = useState('');
  useEffect(() => { fetch(new URL('../../../asset-manifest.json', import.meta.url)).then(r => r.json()).then(m => setVer(m.version + ' · ' + new Date(m.built).toLocaleDateString())).catch(() => {}); }, []);
  const yes = (b) => b ? html`<span class="ok">Yes</span>` : html`<span class="warn">No</span>`;
  return html`<div class="card"><div class="card-title"><${Icon} name="logo" />Ai Agent</div><div class="kv">
    <span>Version</span><span>${ver || '—'}</span>
    <span>Installed app</span><span>${yes(e.standalone)}</span>
    <span>WebGPU</span><span>${e.webgpu ? html`<span class="ok">${e.webgpu.vendor || 'yes'} ${e.webgpu.arch || ''}${e.webgpu.f16 ? ' · f16' : ''}</span>` : yes(false)}</span>
    <span>Multithreading</span><span>${yes(e.isolated)}${e.isolated ? ` · ${navigator.hardwareConcurrency} cores` : ''}</span>
    <span>Screen</span><span>${e.width}×${e.height} pt · ${e.unfolded ? 'unfolded' : 'folded'}</span>
    <span>Network</span><span>${e.online ? 'online' : 'offline'}</span></div></div>
    <div class="card small dim">Open-source parts: Preact, htm, CodeMirror, marked, highlight.js, DOMPurify, KaTeX, llama.cpp / wllama, WebLLM (MLC), ONNX Runtime Web, transformers.js, Pyodide, v86, ffmpeg.wasm, docx, SheetJS, PptxGenJS, pdf-lib, PDF.js, JSZip, mammoth, xterm.js, Anthropic SDK. Each is under its own license (MIT, Apache-2.0, BSD or similar).</div>`;
}
