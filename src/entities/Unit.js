import { Transform, Health, Owner, Cargo, Combat } from './components.js';

// How wide each role's body is drawn, as a fraction of its sprite box — these
// mirror the shapes in render/sprites/ShapeSprites.js (worker: a circle of
// radius 0.36; the boxy roles: a square inset by 0.14 a side; the vehicles and
// beasts: a hexagon of radius 0.46; and so on). Movement needs them so units
// keep apart by what is actually drawn rather than by one assumed size: a
// hexagon vehicle is a third wider than a worker, and spacing everything as if
// it were worker-sized leaves the big ones visibly overlapping.
const BODY_WIDTH_BY_ROLE = {
  worker: 0.72,
  infantry: 0.72, raider: 0.72, fastStriker: 0.72,
  ranged: 0.80,
  lightVehicle: 0.92, heavyVehicle: 0.92, heavyBeast: 0.92, heavySiege: 0.92,
  summon: 0.60,
};
const DEFAULT_BODY_WIDTH = 0.72; // ShapeSprites falls back to the infantry shape

// Sprite box size in tiles, matching drawUnit in render/layers/EntityLayer.js.
function spriteScale(role, isHero) {
  return isHero ? 0.85 : role === 'worker' ? 0.75 : 0.7;
}

export function bodyRadiusOf(role, isHero) {
  return (BODY_WIDTH_BY_ROLE[role] ?? DEFAULT_BODY_WIDTH) * spriteScale(role, isHero) / 2;
}

// Builds a live unit entity from a data-table unit definition (see
// src/data/races/*.js). Engine code only ever reads `def` fields by name —
// content authors never touch this file.
export function createUnit(store, { ownerId, def, x, y, isHero = false }) {
  const entity = {
    kind: 'unit',
    typeId: def.id,
    name: def.name,
    role: def.role,
    isHero,
    bodyRadius: bodyRadiusOf(def.role, isHero),
    ...Transform(x, y),
    ...Owner(ownerId),
    ...Health(def.hp),
    ...Cargo(def.cargoCapacity || 0),
    ...Combat({
      dmgMin: def.dmg?.min ?? 0,
      dmgMax: def.dmg?.max ?? 0,
      dmgType: def.dmg?.type ?? 'normal',
      range: def.range ?? 1,
      cooldown: def.cooldown ?? 1,
      sight: def.sight ?? 6,
    }),
    armor: def.armor ?? 0,
    armorClass: def.armorClass ?? 'normal',
    speed: def.speed ?? 2.4,
    canBuild: !!def.canBuild,
    canGather: !!def.canGather,
    supplyCost: def.supplyCost ?? 1,

    // Movement / order state
    state: 'idle', // idle | moving | attacking | gathering | movingToDropoff | casting
    path: null,
    pathIndex: 0,
    moveTarget: null, // {x,y} final destination
    order: null,      // pending high-level order, e.g. {type:'gather', nodeId}

    // Hero-only fields (unused otherwise)
    level: isHero ? 1 : 0,
    xp: 0,
    xpToNext: isHero ? 100 : Infinity,
    abilityPoints: 0,
    abilities: isHero ? (def.abilities || []).map((id) => ({ id, level: 0, cooldownLeft: 0 })) : [],
  };
  return store.add(entity);
}

export function isAlive(unit) {
  return unit.hp > 0;
}
