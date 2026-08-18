// Per-race tech DAGs, referenced by races/*.js `techtreeId`. Each node:
// { id, cost, researchTime, requires:[ids], unlocks:[buildingOrUnitIds], researchedAt: buildingTypeId }
// `unlocks` is informational for UI; the actual gate is buildings/units
// declaring `requiresTech` and ProductionSystem/BuildPlacementController
// checking `player.researchedTech`.
//
// Currently empty for all three races — the simplified 3-building roster
// (Townhall / Barracks / Hero Altar) has no tech-gated buildings or units
// left to unlock. Kept as empty objects (not removed) because
// AIBuildOrder.js does `Object.values(ctx.techtreesById[race.techtreeId])`
// unconditionally, so the lookup must keep resolving to a valid object.

export const cogforgeTech = {};
export const thornbackTech = {};
export const vharnTech = {};

export const techtreesById = {
  cogforgeTech, thornbackTech, vharnTech,
};
