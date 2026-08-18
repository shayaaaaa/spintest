import { createBuilding } from '../entities/Building.js';
import { canAfford } from '../systems/ProductionSystem.js';

// Touch-friendly build placement: tap "Build: X" -> ghost footprint appears
// (drag repositions it, handled in InputMapper), confirm/cancel via UI
// buttons or tapping the ghost. Construction then progresses automatically
// over time (ProductionSystem) — no separate "worker walks to site" step,
// which keeps the touch flow to a single confirm tap.
export function startPlacement(ctx, view, ownerId, buildingTypeId) {
  const race = ctx.racesById[ctx.players[ownerId].raceId];
  const def = race.buildings[buildingTypeId];
  if (!def) return;
  view.buildGhost = {
    ownerId, typeId: buildingTypeId, def,
    footprint: def.footprint || { w: 2, h: 2 },
    x: view.camera.x, y: view.camera.y,
    valid: false,
  };
  refreshValidity(ctx, view.buildGhost);
}

export function cancelPlacement(view) {
  view.buildGhost = null;
}

export function refreshValidity(ctx, ghost) {
  const { w, h } = ghost.footprint;
  const topLeftX = Math.round(ghost.x - w / 2);
  const topLeftY = Math.round(ghost.y - h / 2);
  ghost.x = topLeftX + w / 2;
  ghost.y = topLeftY + h / 2;

  let ok = true;
  for (let y = topLeftY; y < topLeftY + h && ok; y++) {
    for (let x = topLeftX; x < topLeftX + w; x++) {
      if (!ctx.map.grid.isWalkable(x, y)) { ok = false; break; }
    }
  }
  const player = ctx.players[ghost.ownerId];
  if (!canAfford(player, ghost.def.cost)) ok = false;
  if (ghost.def.requiresTech && !player.researchedTech.has(ghost.def.requiresTech)) ok = false;
  ghost.valid = ok;
  return ok;
}

export function confirmPlacement(ctx, view) {
  const ghost = view.buildGhost;
  if (!ghost || !refreshValidity(ctx, ghost)) return { ok: false };
  const player = ctx.players[ghost.ownerId];
  for (const [res, amt] of Object.entries(ghost.def.cost || {})) player.resources[res] -= amt;

  const topLeftX = Math.round(ghost.x - ghost.footprint.w / 2);
  const topLeftY = Math.round(ghost.y - ghost.footprint.h / 2);
  const building = createBuilding(ctx.store, {
    ownerId: ghost.ownerId, def: ghost.def, x: ghost.x, y: ghost.y, underConstruction: true,
  });
  ctx.map.grid.setRectBlocked(topLeftX, topLeftY, ghost.footprint.w, ghost.footprint.h, true);
  ctx.eventBus.emit('resourcesChanged', { ownerId: ghost.ownerId });
  ctx.eventBus.emit('buildingPlaced', { building });
  view.buildGhost = null;
  return { ok: true, building };
}
