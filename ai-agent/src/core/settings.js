// App settings (Hub/settings/settings.json) and secrets (Hub/settings/secrets.json), as reactive stores.
import * as vfs from './vfs.js';
import { createStore } from './store.js';
import { debounce } from './util.js';

const SETTINGS = '/settings/settings.json';
const SECRETS = '/settings/secrets.json';
const PERMS = '/settings/permissions.json';

export const DEFAULT_SETTINGS = {
  version: 1,
  theme: 'system',              // system | dark | light
  accent: 'iris',               // iris | mint | amber | rose | sky
  layout: 'adaptive',           // adaptive (two panes when unfolded) | single
  panes: { left: 'agent', right: 'code' },
  fontSize: 15,
  monoFont: 'ui-monospace',
  models: {
    agent: '', chat: '', code: '', complete: '', subagent: '', title: '',
    embed: 'onnx:Xenova/all-MiniLM-L6-v2', vision: '', stt: 'system', tts: 'system',
  },
  agent: { maxTurns: 60, temperature: 0.6, maxTokens: 4096, autoCompact: true, compactAt: 0.8, thinking: 'auto', showThinking: true },
  chat: { persona: 'default', voice: '', speakReplies: false, webSearch: 'auto' },
  web: { mode: 'auto', proxyUrl: '', allowReader: true },     // auto | cloud | reader | proxy | off
  providers: {
    anthropic: { enabled: true }, openai: { enabled: true }, xai: { enabled: true }, gemini: { enabled: true },
    openrouter: { enabled: true }, groq: { enabled: true }, mistral: { enabled: true }, deepseek: { enabled: true },
    custom: { enabled: false, baseUrl: 'http://localhost:11434/v1', label: 'Custom (OpenAI-compatible)' },
  },
  linux: { ramMB: 768 },
  offload: { hfNamespace: '', companionUrl: '' },
  onboarded: false,
  lastProject: '/workspace/welcome',
};

export const settings = createStore(structuredClone(DEFAULT_SETTINGS));
export const secrets = createStore({});
export const permissions = createStore({ mode: 'ask', allow: [], deny: [], ask: [] });

function deepMerge(base, over) {
  if (!over || typeof over !== 'object' || Array.isArray(over)) return over ?? base;
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [k, v] of Object.entries(over)) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && base?.[k] && typeof base[k] === 'object' ? deepMerge(base[k], v) : v;
  }
  return out;
}

let loaded = false;
export async function loadSettings() {
  settings.replace(deepMerge(structuredClone(DEFAULT_SETTINGS), await vfs.readJSON(SETTINGS, {})));
  secrets.replace(await vfs.readJSON(SECRETS, {}));
  permissions.replace(deepMerge({ mode: 'ask', allow: [], deny: [], ask: [] }, await vfs.readJSON(PERMS, {})));
  loaded = true;
}

const saveSettings = debounce(() => vfs.writeJSON(SETTINGS, settings.get()).catch(console.error), 300);
const saveSecrets = debounce(() => vfs.writeJSON(SECRETS, secrets.get()).catch(console.error), 300);
const savePerms = debounce(() => vfs.writeJSON(PERMS, permissions.get()).catch(console.error), 300);
settings.subscribe(() => loaded && saveSettings());
secrets.subscribe(() => loaded && saveSecrets());
permissions.subscribe(() => loaded && savePerms());

// Reload when files are edited by hand in the Hub tab or by the agent.
vfs.events.on('change', async (e) => {
  if (!loaded || e.type !== 'write') return;
  try {
    if (e.path === SETTINGS) { const v = await vfs.readJSON(SETTINGS, null); if (v && JSON.stringify(v) !== JSON.stringify(settings.get())) settings.replace(deepMerge(structuredClone(DEFAULT_SETTINGS), v)); }
    if (e.path === PERMS) { const v = await vfs.readJSON(PERMS, null); if (v && JSON.stringify(v) !== JSON.stringify(permissions.get())) permissions.replace(v); }
    if (e.path === SECRETS) { const v = await vfs.readJSON(SECRETS, null); if (v && JSON.stringify(v) !== JSON.stringify(secrets.get())) secrets.replace(v); }
  } catch {}
});

export function setSetting(path, value) {
  const keys = path.split('.');
  settings.set(s => {
    const next = structuredClone(s);
    let o = next;
    for (const k of keys.slice(0, -1)) o = o[k] ??= {};
    o[keys.at(-1)] = value;
    return next;
  });
}

export function getSetting(path) {
  return path.split('.').reduce((o, k) => o?.[k], settings.get());
}

export const getSecret = (name) => secrets.get()[name] || '';
export const setSecret = (name, value) => secrets.set({ [name]: value });
