// Component-shaped field factories. Entities are plain objects that mix
// these in directly (no archetype/table indirection) — simple and fast
// enough at the ~150-250 active unit scale this prototype targets.

export function Transform(x, y) {
  return { x, y, renderX: x, renderY: y, facing: 0 };
}

export function Health(max) {
  return { hp: max, maxHp: max, armor: 0, armorClass: 'normal' };
}

export function Owner(playerId) {
  return { ownerId: playerId };
}

export function Cargo(capacity) {
  return { cargoType: null, cargoAmount: 0, cargoCapacity: capacity };
}

export function Combat({ dmgMin, dmgMax, dmgType = 'normal', range = 1, cooldown = 1, sight = 6 }) {
  return {
    dmgMin, dmgMax, dmgType, range, cooldown, sight,
    attackTimer: 0,
    targetId: null,
    stance: 'aggressive', // aggressive | defensive | passive | holdPosition
  };
}
