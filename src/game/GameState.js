// Serialization format + localStorage I/O. Reconstructing live entities
// from a snapshot is Game.js's job (applySnapshot) since it already owns
// store/map/grid setup — this file only knows the plain-data shape.
const STORAGE_KEY = 'rts_prototype_save_v1';

export function serialize(ctx) {
  const players = Object.values(ctx.players).map((p) => ({
    id: p.id, raceId: p.raceId, isAI: p.isAI,
    resources: { ...p.resources }, researchedTech: [...p.researchedTech],
  }));

  const units = [];
  const buildings = [];
  const resourceNodes = [];
  for (const e of ctx.store.all) {
    if (e.kind === 'unit') {
      units.push({
        ownerId: e.ownerId, typeId: e.typeId, x: e.x, y: e.y, hp: e.hp, isHero: e.isHero,
        level: e.level, xp: e.xp, xpToNext: e.xpToNext, abilityPoints: e.abilityPoints,
        abilities: e.abilities.map((a) => ({ id: a.id, level: a.level })),
        cargoType: e.cargoType, cargoAmount: e.cargoAmount, stance: e.stance,
      });
    } else if (e.kind === 'building') {
      buildings.push({
        ownerId: e.ownerId, typeId: e.typeId, x: e.x, y: e.y, hp: e.hp,
        underConstruction: e.underConstruction, constructionProgress: e.constructionProgress,
        queue: e.queue.map((q) => ({ ...q })),
      });
    } else if (e.kind === 'resourceNode') {
      resourceNodes.push({ resourceType: e.resourceType, amount: e.amount, x: e.x, y: e.y, maxHarvesters: e.maxHarvesters });
    }
  }

  return { version: 1, levelId: ctx.levelId, time: ctx.time, players, units, buildings, resourceNodes };
}

export function saveToLocalStorage(ctx) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(serialize(ctx)));
    return true;
  } catch {
    return false;
  }
}

export function loadFromLocalStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function hasSavedGame() {
  return !!localStorage.getItem(STORAGE_KEY);
}

export function clearSavedGame() {
  localStorage.removeItem(STORAGE_KEY);
}
