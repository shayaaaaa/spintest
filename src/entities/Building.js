import { Transform, Health, Owner } from './components.js';

// Buildings occupy a footprint of tiles (def.footprint, default 2x2),
// have a production queue, and optionally an active research job.
export function createBuilding(store, { ownerId, def, x, y, underConstruction = false }) {
  const footprint = def.footprint || { w: 2, h: 2 };
  const entity = {
    kind: 'building',
    typeId: def.id,
    name: def.name,
    isTownHall: !!def.isTownHall,
    ...Transform(x, y),
    ...Owner(ownerId),
    ...Health(underConstruction ? 1 : def.hp),
    armor: def.armor ?? 0,
    armorClass: def.armorClass ?? 'fortified',
    sight: def.sight ?? 6,
    footprint,
    providesSupply: def.providesSupply || 0,
    trains: def.trains || [],
    researches: def.researches || [],

    underConstruction,
    constructionMaxHp: def.hp,
    constructionProgress: underConstruction ? 0 : 1,
    constructionTime: def.buildTime || 30,

    queue: [], // [{kind:'unit'|'tech', id, timeLeft, totalTime}]
    rallyPoint: null,
  };
  return store.add(entity);
}
