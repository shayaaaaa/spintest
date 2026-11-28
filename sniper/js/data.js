// Static game data: rifles, upgrades, enemies, maps and missions.

export const BASE_FOV = 50;           // vertical field of view without scope (degrees)
export const EYE = { x: 0, y: 9.2, z: 0 };
export const WALL_Z = -14;            // z of the barricade line
export const WALL_HALF = 22;          // barricade spans x in [-WALL_HALF, WALL_HALF]

export const CLASSES = [
  { key: 'sniper', name: 'Snipers', one: 'Sniper', blurb: 'Long range, headshots, scope.' },
  { key: 'auto', name: 'Automatics', one: 'Automatic', blurb: 'Hold to fire. For packs near the wall.' },
  { key: 'pistol', name: 'Pistols', one: 'Pistol', blurb: 'Always carried. Swaps in instantly.' },
  { key: 'rocket', name: 'Rockets', one: 'Rocket', blurb: 'Splash damage, unlimited, long reload.' },
];

// Shared weapon fields: dmg (per hit), bolt (seconds between shots), mag, reload (s), zoom (aim magnification),
// pen (bodies a round passes through), recoil, swap (seconds to switch to it), tier (upgrade price scale).
// Automatics and pistols: spread grows by `heat` per shot up to `spreadMax` (radians) and cools at `cool` rad/s;
// damage falls off between falloff[0] and falloff[1] metres down to falloff[2]; hs scales headshot damage.
// Rockets: blast radius (m) and speed (m/s).
export const WEAPONS = [
  { id: 'ranger',  cls: 'sniper', tier: 0, name: 'Ranger M1',    desc: 'Reliable bolt-action. Every outpost sniper starts here.',
    price: 0,     dmg: 60,  bolt: 1.1,  mag: 5,  reload: 2.4, zoom: 4,  sway: 1.0,  pen: 1, recoil: 1.0, semi: false,
    look: { stock: 0x7a5232, body: 0x2d3033, len: 1.0, scope: 0.9 } },
  { id: 'vulture', cls: 'sniper', tier: 1, name: 'Vulture 308',  desc: 'Heavier round and sharper glass. One headshot drops a brute faster.',
    price: 2500,  dmg: 88,  bolt: 0.95, mag: 6,  reload: 2.2, zoom: 6,  sway: 0.85, pen: 1, recoil: 1.1, semi: false,
    look: { stock: 0x4a5a3a, body: 0x26292b, len: 1.1, scope: 1.0 } },
  { id: 'hornet',  cls: 'sniper', tier: 2, name: 'Hornet SR',    desc: 'Semi-automatic marksman rifle. Fast follow-up shots, ten-round box.',
    price: 6000,  dmg: 64,  bolt: 0.32, mag: 10, reload: 2.5, zoom: 5,  sway: 0.9,  pen: 1, recoil: 0.8, semi: true,
    look: { stock: 0x2b2f36, body: 0x1e2124, len: 0.95, scope: 0.9, mag: true } },
  { id: 'longbow', cls: 'sniper', tier: 3, name: 'Longbow .338', desc: 'Magnum round that punches through two infected in a line.',
    price: 12000, dmg: 145, bolt: 1.25, mag: 5,  reload: 2.6, zoom: 8,  sway: 0.65, pen: 2, recoil: 1.4, semi: false,
    look: { stock: 0x5b4630, body: 0x2a2c2e, len: 1.25, scope: 1.15 } },
  { id: 'thunder', cls: 'sniper', tier: 4, name: 'Thunder .50',  desc: 'Anti-materiel rifle. Pierces three bodies and blows them apart.',
    price: 24000, dmg: 260, bolt: 1.5,  mag: 4,  reload: 3.0, zoom: 10, sway: 0.7,  pen: 3, recoil: 2.0, semi: false,
    look: { stock: 0x3a3f36, body: 0x1d1f21, len: 1.4, scope: 1.25, brake: true, bipod: true } },
  { id: 'phantom', cls: 'sniper', tier: 5, name: 'Phantom X',    desc: 'Prototype semi-auto with a stabilized 12x scope.',
    price: 42000, dmg: 150, bolt: 0.38, mag: 8,  reload: 2.0, zoom: 12, sway: 0.35, pen: 2, recoil: 1.1, semi: true,
    look: { stock: 0x1d2a3a, body: 0x15181c, len: 1.2, scope: 1.2, mag: true, brake: true } },

  { id: 'viper',    cls: 'auto', tier: 1, name: 'Viper Carbine', desc: 'Light, fast and forgiving. Hold the trigger and sweep the wall clean.',
    price: 3500,  dmg: 34, bolt: 0.1,  mag: 30,  reload: 2.0, zoom: 2,   pen: 1, recoil: 0.32, auto: true,
    heat: 0.006, spreadMax: 0.035, cool: 0.09, falloff: [35, 95, 0.45], hs: 0.6, swap: 0.45,
    look: { body: 0x2a2d30, furn: 0x3a3e36, len: 0.85, mag: 'curved' } },
  { id: 'ironclad', cls: 'auto', tier: 2, name: 'Ironclad BR',   desc: 'Battle rifle. Slower, heavier rounds that still hurt at range.',
    price: 9000,  dmg: 60, bolt: 0.15, mag: 20,  reload: 2.3, zoom: 3,   pen: 1, recoil: 0.5, auto: true,
    heat: 0.007, spreadMax: 0.03, cool: 0.09, falloff: [50, 120, 0.5], hs: 0.65, swap: 0.5,
    look: { body: 0x26282a, furn: 0x6a5236, len: 1.0, mag: 'box' } },
  { id: 'grinder',  cls: 'auto', tier: 4, name: 'Grinder LMG',   desc: 'A 100-round belt. Built for holding a wall against a horde.',
    price: 18000, dmg: 48, bolt: 0.08, mag: 100, reload: 5.0, zoom: 2.2, pen: 1, recoil: 0.42, auto: true,
    heat: 0.005, spreadMax: 0.04, cool: 0.07, falloff: [40, 110, 0.45], hs: 0.6, swap: 0.6,
    look: { body: 0x2c3028, furn: 0x2c3028, len: 1.1, mag: 'drum', bipod: true } },

  { id: 'service',  cls: 'pistol', tier: 0, name: 'Service 9',    desc: 'Standard sidearm. Never runs dry and comes up in a blink.',
    price: 0,     dmg: 42,  bolt: 0.2,   mag: 12, reload: 1.3, zoom: 1.5, pen: 1, recoil: 0.55, semi: true,
    heat: 0.008, spreadMax: 0.02, cool: 0.1, falloff: [25, 80, 0.4], hs: 0.85, swap: 0.25,
    look: { body: 0x23262a, grip: 0x2e2a26 } },
  { id: 'bulldog',  cls: 'pistol', tier: 1, name: 'Bulldog .44',  desc: 'Six heavy rounds. Hits like a rifle up close.',
    price: 2200,  dmg: 110, bolt: 0.45,  mag: 6,  reload: 2.0, zoom: 1.7, pen: 1, recoil: 1.3, semi: true,
    heat: 0.012, spreadMax: 0.02, cool: 0.1, falloff: [30, 90, 0.45], hs: 0.9, swap: 0.25,
    look: { body: 0x8a8e92, grip: 0x5a3a24, revolver: true } },
  { id: 'wasp',     cls: 'pistol', tier: 2, name: 'Wasp MP',      desc: 'Fully automatic machine pistol. Empties fast, reloads fast.',
    price: 5000,  dmg: 28,  bolt: 0.065, mag: 24, reload: 1.5, zoom: 1.5, pen: 1, recoil: 0.28, auto: true,
    heat: 0.007, spreadMax: 0.04, cool: 0.1, falloff: [20, 70, 0.4], hs: 0.75, swap: 0.25,
    look: { body: 0x1e2124, grip: 0x1e2124, long: true } },

  { id: 'thumper',  cls: 'rocket', tier: 2, name: 'Thumper RPG',  desc: 'One rocket, a big blast and a long reload. Never runs out.',
    price: 8000,  dmg: 650, bolt: 0.5,  mag: 1, reload: 4.5, zoom: 1.6, pen: 1, recoil: 2.2, blast: 6, speed: 55, swap: 0.6,
    look: { body: 0x4e5a36, tubes: 1 } },
  { id: 'hydra',    cls: 'rocket', tier: 4, name: 'Hydra-3',      desc: 'Three-tube launcher. Fires a salvo, then a very long reload.',
    price: 20000, dmg: 520, bolt: 0.45, mag: 3, reload: 8.5, zoom: 1.8, pen: 1, recoil: 1.8, blast: 5.5, speed: 62, swap: 0.6,
    look: { body: 0x3a3f44, tubes: 3 } },
];
export const RIFLES = WEAPONS;

export const UPGRADES = [
  { key: 'dmg', max: 5, cost: [300, 650, 1150, 1900, 2900] },
  { key: 'mag', max: 3, cost: [400, 900, 1600] },
  { key: 'rel', max: 3, cost: [350, 800, 1400] },
  { key: 'stb', max: 3, cost: [300, 700, 1300] },
];

// Upgrade names, descriptions and level caps depend on the weapon class.
export function upgradeInfo(cls, key) {
  const t = {
    dmg: ['Damage', '+12% damage per level', 5],
    mag: cls === 'rocket' ? ['Rockets', '+1 rocket per load', 2]
      : cls === 'sniper' ? ['Magazine', '+1 round per level (+2 on semi-autos)', 3] : ['Magazine', '+20% rounds per level', 3],
    rel: ['Reload', '13% faster reload per level', 3],
    stb: cls === 'rocket' ? ['Blast radius', '+10% blast radius per level', 3]
      : cls === 'sniper' ? ['Stability', 'Less scope sway and recoil', 3] : ['Control', 'Less recoil and bullet spread', 3],
  }[key];
  return { name: t[0], info: t[1], max: t[2] };
}

export function weaponById(id) { return WEAPONS.find(w => w.id === id) || WEAPONS[0]; }
export function rifleIndex(id) { return Math.max(0, WEAPONS.findIndex(r => r.id === id)); }

export function upgradeCost(id, key, level) {
  const w = weaponById(id);
  const u = UPGRADES.find(x => x.key === key);
  if (!u || level >= upgradeInfo(w.cls, key).max) return null;
  return Math.round(u.cost[level] * (1 + w.tier * 0.55) / 50) * 50;
}

export function weaponStats(id, upg = {}) {
  const w = weaponById(id);
  const dmgL = upg.dmg || 0, magL = upg.mag || 0, relL = upg.rel || 0, stbL = upg.stb || 0;
  const magStep = w.cls === 'sniper' ? (w.semi ? 2 : 1) : w.cls === 'rocket' ? 1 : Math.max(2, Math.round(w.mag * 0.2));
  return {
    sway: 1, hs: 1, heat: 0, spreadMax: 0, cool: 1, falloff: null, swap: 0.55,
    ...w,
    dmg: Math.round(w.dmg * (1 + 0.12 * dmgL)),
    mag: w.mag + magL * magStep,
    reload: +(w.reload * Math.pow(0.87, relL)).toFixed(2),
    sway: (w.sway ?? 1) * (1 - 0.2 * stbL),
    recoil: w.recoil * (1 - 0.12 * stbL),
    spreadMax: (w.spreadMax || 0) * (1 - 0.15 * stbL),
    blast: w.blast ? +(w.blast * (1 + 0.1 * stbL)).toFixed(1) : 0,
  };
}
export const rifleStats = weaponStats;

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

// ---------------------------------------------------------------- Horde mode (you command the infected)
// Brains are spent during a siege to send zombies. DNA is earned from sieges and spent in the Lab.
export const HORDE_UNLOCK_MISSION = 8;   // campaign missions to finish before Horde opens (the farm map)

export const HORDE_UNITS = [
  { key: 'walker',  cost: 10,  cd: 0.4, unlock: 0,   factor: 1,   desc: 'Cheap and slow. Soaks up bullets.' },
  { key: 'runner',  cost: 16,  cd: 0.8, unlock: 0,   factor: 1.1, desc: 'Fast and fragile. Send them while the sniper reloads.' },
  { key: 'soldier', cost: 28,  cd: 1.2, unlock: 120, factor: 1.3, desc: 'Its helmet stops the first headshot.' },
  { key: 'bloater', cost: 35,  cd: 2.0, unlock: 200, factor: 1.4, desc: 'Blows a hole in the wall. If it is shot early it explodes on your own horde.' },
  { key: 'brute',   cost: 50,  cd: 2.5, unlock: 250, factor: 1.5, desc: 'Slow and very tough. Hits the wall hard.' },
  { key: 'boss',    cost: 180, cd: 0,   unlock: 900, factor: 2,   once: true, desc: 'The Butcher. One per siege.' },
];
export const MUTATION = { max: 5, cost: [60, 110, 180, 280, 420], hp: 0.15, speed: 0.05, wall: 0.12 };
export function mutationCost(unitKey, level) {
  const u = HORDE_UNITS.find(x => x.key === unitKey);
  if (!u || level >= MUTATION.max) return null;
  return Math.round(MUTATION.cost[level] * u.factor / 10) * 10;
}

export const HORDE_ABILITIES = [
  { key: 'fog',    name: 'Fog',    unlock: 0,   max: 3, cost: [150, 300, 500], cd: 26, cdPer: -2,
    dur: 6, durPer: 1, desc: 'Smoke rolls over the field. Defenders aim slower and miss far more.' },
  { key: 'roar',   name: 'Roar',   unlock: 180, max: 3, cost: [150, 300, 500], cd: 24, cdPer: -2,
    dur: 5, durPer: 1, desc: 'Your whole horde runs 60% faster.' },
  { key: 'burrow', name: 'Burrow', unlock: 350, max: 3, cost: [200, 380, 600], cd: 32, cdPer: -3,
    n: 3, nPer: 1, desc: 'Your next zombies dig up right in front of the wall.' },
];

export const HIVE = { key: 'income', name: 'Brain hunger', max: 5, cost: [120, 220, 360, 540, 780], per: 0.1, base: 6, start: 80,
  desc: 'You earn brains 10% faster per level.' };

// Defender slots around the outpost: the tower top, a scaffold, and two nests behind the wall.
export const DEFENDER_SLOTS = {
  tower: { x: 0, y: 8.02, z: -0.9 },
  scaffold: { x: 17, y: 5.02, z: -9 },
  nestL: { x: -7, y: 1.22, z: -11.6 },
  nestR: { x: 7, y: 1.22, z: -11.6 },
};

const HS = (w, acc) => ({ kind: 'sniper', w, acc, slot: 'tower' });
const HS2 = (w, acc) => ({ kind: 'sniper', w, acc, slot: 'scaffold' });
const HG = (w, acc) => ({ kind: 'gunner', w, acc, slot: 'nestL' });
const HR = w => ({ kind: 'rocket', w, acc: 0.7, slot: 'nestR' });

export const HORDE_LEVELS = [
  { name: 'Lone Rifle',        map: 0, wall: 600,  time: 150, reward: 120, defenders: [HS('ranger', 0.62)] },
  { name: 'Steady Hands',      map: 0, wall: 800,  time: 150, reward: 150, defenders: [HS('vulture', 0.7)] },
  { name: 'Spray Line',        map: 0, wall: 900,  time: 170, reward: 180, defenders: [HS('ranger', 0.64), HG('viper', 0.26)] },
  { name: 'Hollow Creek Falls', map: 0, wall: 1000, time: 180, reward: 220, defenders: [HS('vulture', 0.66), HG('viper', 0.28)] },
  { name: 'Main Street',       map: 1, wall: 1200, time: 170, reward: 260, defenders: [HS('hornet', 0.68), HG('ironclad', 0.36)] },
  { name: 'Rocket Man',        map: 1, wall: 1300, time: 180, reward: 300, defenders: [HS('vulture', 0.72), HR('thumper')] },
  { name: 'Crossfire',         map: 1, wall: 1400, time: 190, reward: 340, defenders: [HS('vulture', 0.72), HG('ironclad', 0.33), HR('thumper')] },
  { name: "The Mayor's Guard", map: 1, wall: 1700, time: 200, reward: 380, defenders: [HS('longbow', 0.74), HS2('hornet', 0.62), HG('viper', 0.32)] },
  { name: 'Dock Patrol',       map: 2, wall: 1600, time: 190, reward: 420, defenders: [HS('longbow', 0.74), HG('grinder', 0.34), HR('thumper')] },
  { name: 'Two Towers',        map: 2, wall: 1700, time: 200, reward: 460, defenders: [HS('thunder', 0.74), HS2('longbow', 0.62), HR('hydra')] },
  { name: 'Iron Curtain',      map: 2, wall: 2000, time: 220, reward: 520, defenders: [HS('thunder', 0.78), HG('grinder', 0.38), HR('hydra')] },
  { name: 'The Phantom',       map: 2, wall: 2300, time: 230, reward: 600, defenders: [HS('phantom', 0.82), HS2('thunder', 0.68), HG('grinder', 0.4), HR('hydra')] },
].map((L, i) => ({ ...L, i }));

// Endless siege: break one outpost after another; each rebuilt wall is stronger and better defended.
export function hordeRound(n, map) {
  const defenders = [HS(n < 3 ? 'ranger' : n < 6 ? 'vulture' : n < 9 ? 'longbow' : 'thunder', Math.min(0.88, 0.6 + n * 0.025))];
  if (n >= 2) defenders.push(HG(n < 6 ? 'viper' : n < 10 ? 'ironclad' : 'grinder', Math.min(0.45, 0.24 + n * 0.02)));
  if (n >= 4) defenders.push(HR(n < 8 ? 'thumper' : 'hydra'));
  if (n >= 7) defenders.push(HS2(n < 11 ? 'hornet' : 'phantom', Math.min(0.75, 0.55 + n * 0.015)));
  return { name: `Round ${n}`, map, wall: 700 + 220 * n, time: 150, reward: 0, defenders, endless: true, i: -1 };
}
