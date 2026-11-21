// Static game data: rifles, upgrades, enemies, maps and missions.

export const BASE_FOV = 50;           // vertical field of view without scope (degrees)
export const EYE = { x: 0, y: 9.2, z: 0 };
export const WALL_Z = -14;            // z of the barricade line
export const WALL_HALF = 22;          // barricade spans x in [-WALL_HALF, WALL_HALF]

export const RIFLES = [
  { id: 'ranger',  name: 'Ranger M1',    desc: 'Reliable bolt-action. Every outpost sniper starts here.',
    price: 0,     dmg: 60,  bolt: 1.1,  mag: 5,  reload: 2.4, zoom: 4,  sway: 1.0,  pen: 1, recoil: 1.0, semi: false,
    look: { stock: 0x7a5232, body: 0x2d3033, len: 1.0, scope: 0.9 } },
  { id: 'vulture', name: 'Vulture 308',  desc: 'Heavier round and sharper glass. One headshot drops a brute faster.',
    price: 2500,  dmg: 88,  bolt: 0.95, mag: 6,  reload: 2.2, zoom: 6,  sway: 0.85, pen: 1, recoil: 1.1, semi: false,
    look: { stock: 0x4a5a3a, body: 0x26292b, len: 1.1, scope: 1.0 } },
  { id: 'hornet',  name: 'Hornet SR',    desc: 'Semi-automatic marksman rifle. Fast follow-up shots, ten-round box.',
    price: 6000,  dmg: 64,  bolt: 0.32, mag: 10, reload: 2.5, zoom: 5,  sway: 0.9,  pen: 1, recoil: 0.8, semi: true,
    look: { stock: 0x2b2f36, body: 0x1e2124, len: 0.95, scope: 0.9, mag: true } },
  { id: 'longbow', name: 'Longbow .338', desc: 'Magnum round that punches through two infected in a line.',
    price: 12000, dmg: 145, bolt: 1.25, mag: 5,  reload: 2.6, zoom: 8,  sway: 0.65, pen: 2, recoil: 1.4, semi: false,
    look: { stock: 0x5b4630, body: 0x2a2c2e, len: 1.25, scope: 1.15 } },
  { id: 'thunder', name: 'Thunder .50',  desc: 'Anti-materiel rifle. Pierces three bodies and blows them apart.',
    price: 24000, dmg: 260, bolt: 1.5,  mag: 4,  reload: 3.0, zoom: 10, sway: 0.7,  pen: 3, recoil: 2.0, semi: false,
    look: { stock: 0x3a3f36, body: 0x1d1f21, len: 1.4, scope: 1.25, brake: true, bipod: true } },
  { id: 'phantom', name: 'Phantom X',    desc: 'Prototype semi-auto with a stabilized 12x scope.',
    price: 42000, dmg: 150, bolt: 0.38, mag: 8,  reload: 2.0, zoom: 12, sway: 0.35, pen: 2, recoil: 1.1, semi: true,
    look: { stock: 0x1d2a3a, body: 0x15181c, len: 1.2, scope: 1.2, mag: true, brake: true } },
];

export const UPGRADES = [
  { key: 'dmg', name: 'Damage',    max: 5, cost: [300, 650, 1150, 1900, 2900], info: '+12% damage per level' },
  { key: 'mag', name: 'Magazine',  max: 3, cost: [400, 900, 1600],             info: '+1 round per level (+2 on semi-autos)' },
  { key: 'rel', name: 'Reload',    max: 3, cost: [350, 800, 1400],             info: '13% faster reload per level' },
  { key: 'stb', name: 'Stability', max: 3, cost: [300, 700, 1300],             info: 'Less scope sway and recoil' },
];

export function rifleIndex(id) { return Math.max(0, RIFLES.findIndex(r => r.id === id)); }

export function upgradeCost(rifleId, key, level) {
  const u = UPGRADES.find(x => x.key === key);
  if (!u || level >= u.max) return null;
  const tier = rifleIndex(rifleId);
  return Math.round(u.cost[level] * (1 + tier * 0.55) / 50) * 50;
}

export function rifleStats(id, upg = {}) {
  const r = RIFLES[rifleIndex(id)];
  const dmgL = upg.dmg || 0, magL = upg.mag || 0, relL = upg.rel || 0, stbL = upg.stb || 0;
  return {
    ...r,
    dmg: Math.round(r.dmg * (1 + 0.12 * dmgL)),
    mag: r.mag + magL * (r.semi ? 2 : 1),
    reload: +(r.reload * Math.pow(0.87, relL)).toFixed(2),
    sway: r.sway * (1 - 0.2 * stbL),
    recoil: r.recoil * (1 - 0.12 * stbL),
  };
}

export const ITEMS = [
  { key: 'focus',  name: 'Focus',        price: 400, desc: 'Slows the infected to a crawl for 8 seconds. Your rifle stays at full speed.' },
  { key: 'strike', name: 'Mortar Strike', price: 700, desc: 'Shells the ground in front of the wall for two seconds.' },
  { key: 'repair', name: 'Repair Kit',   price: 350, desc: 'Restores 40% of the wall instantly.' },
];

export const WALL_LEVELS = [
  { hp: 1000, cost: 0 },
  { hp: 1300, cost: 900 },
  { hp: 1650, cost: 1800 },
  { hp: 2050, cost: 3200 },
  { hp: 2500, cost: 5200 },
  { hp: 3000, cost: 8000 },
];

export const ZOMBIES = {
  walker:  { name: 'Walker',  hp: 100,  speed: 1.3,  scale: 1.0,  dps: 6,  cash: 15,  headMult: 3 },
  runner:  { name: 'Runner',  hp: 75,   speed: 3.3,  scale: 0.95, dps: 5,  cash: 22,  headMult: 3, lean: 0.42, thin: true },
  brute:   { name: 'Brute',   hp: 450,  speed: 0.8,  scale: 1.45, dps: 16, cash: 60,  headMult: 2.5, wide: true, belly: true },
  soldier: { name: 'Soldier', hp: 160,  speed: 1.2,  scale: 1.02, dps: 8,  cash: 32,  headMult: 3, helmet: true },
  bloater: { name: 'Bloater', hp: 110,  speed: 0.95, scale: 1.15, dps: 0,  cash: 40,  headMult: 3, explode: true, belly: true },
  boss:    { name: 'Butcher', hp: 2800, speed: 0.55, scale: 3.0,  dps: 45, cash: 900, headMult: 2, boss: true, wide: true, belly: true },
};

export const MAPS = [
  { id: 'farm', name: 'Hollow Creek', sub: 'Farmland at noon',
    skyTop: 0x3c7bd0, skyHorizon: 0xcfe2ec, fog: 0xc3d8e2, fogNear: 90, fogFar: 360,
    ground: 0x6f9b44, ground2: 0x8faf55, hemiSky: 0xe4f1ff, hemiGround: 0x5f7442, hemiInt: 1.7,
    sun: 0xfff0d2, sunInt: 2.6, sunDir: [0.45, 0.85, 0.25], disc: { dir: [0.35, 0.55, -0.75], color: 0xfffbe6, size: 14 },
    mountains: 0x9fb8c4 },
  { id: 'town', name: 'Rustwater', sub: 'Abandoned town at dusk',
    skyTop: 0x2a2f62, skyHorizon: 0xf08f5a, fog: 0xc98466, fogNear: 70, fogFar: 320,
    ground: 0x6a6157, ground2: 0x7a6e60, hemiSky: 0xb7a3c4, hemiGround: 0x4a3a30, hemiInt: 1.5,
    sun: 0xffb27e, sunInt: 2.3, sunDir: [-0.55, 0.3, -0.75], disc: { dir: [-0.5, 0.09, -0.86], color: 0xffd09a, size: 22 },
    mountains: 0x8a5e5a },
  { id: 'yard', name: 'Iron Harbor', sub: 'Shipping yard at night',
    skyTop: 0x03060f, skyHorizon: 0x1b2944, fog: 0x121c30, fogNear: 45, fogFar: 240,
    ground: 0x4a5059, ground2: 0x535a63, hemiSky: 0x8ea3d6, hemiGround: 0x262a33, hemiInt: 1.55,
    sun: 0xaec4ff, sunInt: 1.25, sunDir: [0.3, 0.7, -0.6], disc: { dir: [0.42, 0.42, -0.8], color: 0xe9efff, size: 11 },
    mountains: 0x1a2438, night: true },
];

const NAMES = [
  ['First Light', 'Corn Rows', 'Lost Hikers', 'Barn Door', 'Fast Movers', 'School Bus', 'Long Afternoon', 'The Butcher'],
  ['Main Street', 'Gas Station', 'Clinic Run', 'Rush Hour', 'Sirens', 'Last Ferry Out', 'Rooftop Hold', 'The Mayor'],
  ['Container Maze', 'Dock Shift', 'Night Crew', 'Crane Line', 'Steel Rain', 'Lifeboats', 'Floodgate', 'The Colossus'],
];
const BOSS_NAMES = ['Butcher', 'Mayor', 'Colossus'];
const PATTERN = ['defend', 'defend', 'rescue', 'defend', 'defend', 'rescue', 'defend', 'boss'];

export const LEVELS = [];
for (let i = 0; i < 24; i++) {
  const map = i >> 3, k = i & 7, type = PATTERN[k];
  const comp = { walker: Math.round(9 + i * 1.3) };
  if (i >= 1) comp.runner = Math.round(1 + i * 0.6);
  if (i >= 3) comp.brute = Math.round(1 + (i - 3) * 0.3);
  if (i >= 4) comp.bloater = Math.round(1 + (i - 4) * 0.25);
  if (i >= 9) comp.soldier = Math.round(2 + (i - 9) * 0.5);
  const f = type === 'rescue' ? 0.6 : type === 'boss' ? 0.55 : 1;
  for (const key in comp) comp[key] = Math.max(1, Math.round(comp[key] * f));
  LEVELS.push({
    i, map, k, type, name: NAMES[map][k], comp,
    waves: type === 'defend' ? 2 + Math.floor(i / 6) : 2,
    hpMult: 1 + i * 0.065,
    speedMult: 1 + i * 0.012,
    maxAlive: Math.min(16, 5 + Math.floor(i * 0.45)),
    reward: 350 + i * 140,
    survivors: type === 'rescue' ? 5 + map : 0,
    required: type === 'rescue' ? 3 + map : 0,
    boss: type === 'boss' ? { hpMult: 0.8 + map * 0.31, name: BOSS_NAMES[map] } : null,
  });
}

export function levelObjective(L) {
  const total = Object.values(L.comp).reduce((a, b) => a + b, 0);
  if (L.type === 'defend') return `Hold the wall. Eliminate all ${total} infected across ${L.waves} waves.`;
  if (L.type === 'rescue') return `Survivors are running for the outpost. Cover them: at least ${L.required} of ${L.survivors} must reach the wall.`;
  return `Something big is coming. Kill the ${L.boss.name} before it tears the wall down.`;
}

export function survivalWave(n) {
  const comp = { walker: 6 + n * 2 };
  if (n >= 2) comp.runner = n;
  if (n >= 3) comp.brute = Math.floor(n / 3);
  if (n >= 4) comp.bloater = Math.floor(n / 4);
  if (n >= 5) comp.soldier = Math.floor(n / 2.5);
  return {
    comp,
    hpMult: 1 + n * 0.06,
    speedMult: 1 + Math.min(0.4, n * 0.015),
    maxAlive: Math.min(18, 5 + n),
    boss: n % 10 === 0 ? { hpMult: 0.6 + n * 0.04, name: 'Butcher' } : null,
    bonus: 100 + n * 40,
  };
}
