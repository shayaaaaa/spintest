// Persistent progress stored in localStorage (works offline, stays on this device).

const KEY = 'deadeye-outpost-save-v1';

function defaults() {
  return {
    v: 1,
    cash: 300,
    unlocked: 0,                 // highest campaign mission index that can be played
    stars: [],                   // stars[i] = best stars for mission i
    owned: { ranger: true },
    upg: { ranger: { dmg: 0, mag: 0, rel: 0, stb: 0 } },
    equipped: 'ranger',
    items: { focus: 1, strike: 1, repair: 1 },
    wall: 0,
    best: { farm: 0, town: 0, yard: 0 },
    stats: { kills: 0, heads: 0, shots: 0, hits: 0 },
    settings: { sens: 1.0, invertY: false, sound: true, quality: 'auto', killcam: true },
  };
}

function merge(base, over) {
  if (!over || typeof over !== 'object') return base;
  for (const k of Object.keys(over)) {
    const v = over[k];
    if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])) {
      base[k] = merge(base[k], v);
    } else {
      base[k] = v;
    }
  }
  return base;
}

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const s = JSON.parse(raw);
      if (s && s.v === 1) return merge(defaults(), s);
    }
  } catch (e) { /* storage unavailable */ }
  return defaults();
}

export const save = load();

export function persist() {
  try { localStorage.setItem(KEY, JSON.stringify(save)); } catch (e) { /* ignore */ }
}

export function resetSave() {
  const d = defaults();
  d.settings = { ...save.settings };
  for (const k of Object.keys(save)) delete save[k];
  Object.assign(save, d);
  persist();
}

export function upgOf(id) {
  if (!save.upg[id]) save.upg[id] = { dmg: 0, mag: 0, rel: 0, stb: 0 };
  return save.upg[id];
}
