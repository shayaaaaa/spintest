import { enqueueTrain, enqueueResearch, canAfford, currentSupply } from '../systems/ProductionSystem.js';
import { createBuilding } from '../entities/Building.js';

// Generic, data-driven build-order logic: derives what to do next purely
// from each race's data table shape (townHallId/workerTypeId/buildings/
// units/techtree), so the same code drives all three races without
// per-race literal step lists to keep in sync by hand.
const WORKER_TARGET = 7;

function ownTownHall(ctx, ownerId, race) {
  for (const b of ctx.store.buildingsOf(ownerId)) if (b.typeId === race.townHallId) return b;
  return null;
}

function firstIdleBuilding(ctx, ownerId, predicate) {
  for (const b of ctx.store.buildingsOf(ownerId)) {
    if (b.underConstruction || b.queue.length > 0) continue;
    if (predicate(b)) return b;
  }
  return null;
}

// Non-town-hall production buildings, in declaration order (tier1 before tier2 by convention).
function productionBuildingDefs(race) {
  return Object.values(race.buildings).filter((b) => !b.isTownHall && b.trains?.length);
}

export function runEconomyAndBuildOrder(ctx, ownerId, aiState) {
  const player = ctx.players[ownerId];
  const race = ctx.racesById[player.raceId];
  const townHall = ownTownHall(ctx, ownerId, race);
  if (!townHall) return; // base destroyed

  const workerCount = [...ctx.store.unitsOf(ownerId)].filter((u) => u.canGather).length;
  if (workerCount < WORKER_TARGET && townHall.queue.length === 0) {
    enqueueTrain(ctx, townHall, race.workerTypeId);
  }

  const prodDefs = productionBuildingDefs(race);
  for (const def of prodDefs) {
    const gateOk = !def.requiresTech || player.researchedTech.has(def.requiresTech);
    if (!gateOk) continue;
    const already = [...ctx.store.buildingsOf(ownerId)].some((b) => b.typeId === def.id);
    if (!already && canAfford(player, def.cost)) {
      buildAt(ctx, ownerId, def, nearTownHall(ctx, townHall, aiState));
      break;
    }
  }

  // Research: walk each unresearched tech whose prereqs are met, at its building.
  const techtree = ctx.techtreesById[race.techtreeId];
  for (const tech of Object.values(techtree)) {
    if (player.researchedTech.has(tech.id)) continue;
    if (!tech.requires.every((r) => player.researchedTech.has(r))) continue;
    const building = firstIdleBuilding(ctx, ownerId, (b) => b.typeId === tech.researchedAt);
    if (building && canAfford(player, tech.cost)) {
      enqueueResearch(ctx, building, tech.id);
      break;
    }
  }

  // Train combat units from any idle production building with something trainable & affordable.
  for (const building of ctx.store.buildingsOf(ownerId)) {
    if (building.underConstruction || building.queue.length > 0 || building.typeId === race.townHallId) continue;
    for (const unitId of building.trains) {
      const def = race.units[unitId];
      if (!def) continue;
      if (def.requiresTech && !player.researchedTech.has(def.requiresTech)) continue;
      if (!canAfford(player, def.cost)) continue;
      const { used: u2, cap: c2 } = currentSupply(ctx, ownerId);
      if (u2 + (def.supplyCost ?? 1) > c2) continue;
      enqueueTrain(ctx, building, unitId);
      break;
    }
  }

  // Hero: train from the Hero Altar once it exists, and retrain there again
  // whenever the hero has died — hasHero re-evaluates every decision tick,
  // and a dead hero is already gone from the store by the time this runs.
  if (race.heroes) {
    const heroId = Object.keys(race.heroes)[0];
    const hasHero = [...ctx.store.unitsOf(ownerId)].some((u) => u.typeId === heroId);
    const altar = [...ctx.store.buildingsOf(ownerId)].find(
      (b) => !b.underConstruction && b.queue.length === 0 && b.trains?.includes(heroId),
    );
    if (!hasHero && altar && canAfford(player, race.heroes[heroId].cost)) {
      enqueueTrain(ctx, altar, heroId);
    }
  }
}

function nearTownHall(ctx, townHall, aiState) {
  aiState.buildRingIndex = (aiState.buildRingIndex || 0) + 1;
  const angle = aiState.buildRingIndex * 2.4;
  const dist = 4 + (aiState.buildRingIndex % 3);
  return { x: townHall.x + Math.cos(angle) * dist, y: townHall.y + Math.sin(angle) * dist };
}

function buildAt(ctx, ownerId, def, spot) {
  const player = ctx.players[ownerId];
  const footprint = def.footprint || { w: 2, h: 2 };
  const topLeftX = Math.round(spot.x - footprint.w / 2);
  const topLeftY = Math.round(spot.y - footprint.h / 2);
  for (let y = topLeftY; y < topLeftY + footprint.h; y++) {
    for (let x = topLeftX; x < topLeftX + footprint.w; x++) {
      if (!ctx.map.grid.isWalkable(x, y)) return false;
    }
  }
  for (const [res, amt] of Object.entries(def.cost || {})) player.resources[res] -= amt;
  createBuilding(ctx.store, { ownerId, def, x: topLeftX + footprint.w / 2, y: topLeftY + footprint.h / 2, underConstruction: true });
  ctx.map.grid.setRectBlocked(topLeftX, topLeftY, footprint.w, footprint.h, true);
  return true;
}
