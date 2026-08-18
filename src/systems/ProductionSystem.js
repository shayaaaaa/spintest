import { createUnit } from '../entities/Unit.js';
import { moveUnitTo } from './MovementSystem.js';

function raceOf(ctx, ownerId) {
  return ctx.racesById[ctx.players[ownerId].raceId];
}

export function currentSupply(ctx, ownerId) {
  let used = 0, cap = 0;
  for (const u of ctx.store.unitsOf(ownerId)) used += u.supplyCost || 0;
  for (const b of ctx.store.buildingsOf(ownerId)) if (!b.underConstruction) cap += b.providesSupply || 0;
  return { used, cap };
}

export function canAfford(player, cost) {
  return Object.entries(cost || {}).every(([res, amt]) => (player.resources[res] || 0) >= amt);
}

function pay(player, cost) {
  for (const [res, amt] of Object.entries(cost || {})) player.resources[res] -= amt;
}

export function enqueueTrain(ctx, building, unitTypeId) {
  const player = ctx.players[building.ownerId];
  const race = raceOf(ctx, building.ownerId);
  const def = race.units[unitTypeId] || race.heroes?.[unitTypeId];
  if (!def || building.underConstruction) return { ok: false, reason: 'unavailable' };
  if (!canAfford(player, def.cost)) return { ok: false, reason: 'cost' };
  const { used, cap } = currentSupply(ctx, building.ownerId);
  const supplyCost = def.supplyCost ?? 1;
  if (used + supplyCost > cap) return { ok: false, reason: 'supply' };
  if (def.requiresTech && !player.researchedTech.has(def.requiresTech)) return { ok: false, reason: 'tech' };
  if (race.heroes?.[unitTypeId] && [...ctx.store.unitsOf(building.ownerId)].some((u) => u.typeId === unitTypeId)) {
    return { ok: false, reason: 'oneHeroOfType' };
  }
  pay(player, def.cost);
  building.queue.push({ kind: 'unit', id: unitTypeId, timeLeft: def.buildTime, totalTime: def.buildTime });
  ctx.eventBus.emit('resourcesChanged', { ownerId: building.ownerId });
  return { ok: true };
}

export function enqueueResearch(ctx, building, techId) {
  const player = ctx.players[building.ownerId];
  const race = raceOf(ctx, building.ownerId);
  const techtree = ctx.techtreesById[race.techtreeId];
  const def = techtree[techId];
  if (!def || building.underConstruction) return { ok: false, reason: 'unavailable' };
  if (player.researchedTech.has(techId)) return { ok: false, reason: 'already' };
  if (!def.requires.every((r) => player.researchedTech.has(r))) return { ok: false, reason: 'prereq' };
  if (!canAfford(player, def.cost)) return { ok: false, reason: 'cost' };
  pay(player, def.cost);
  building.queue.push({ kind: 'tech', id: techId, timeLeft: def.researchTime, totalTime: def.researchTime });
  ctx.eventBus.emit('resourcesChanged', { ownerId: building.ownerId });
  return { ok: true };
}

export function updateProduction(ctx, dt) {
  for (const building of ctx.store.all) {
    if (building.kind !== 'building') continue;

    if (building.underConstruction) {
      building.constructionProgress += dt / building.constructionTime;
      building.maxHp = building.constructionMaxHp;
      building.hp = Math.max(1, Math.round(building.constructionMaxHp * building.constructionProgress));
      if (building.constructionProgress >= 1) {
        building.underConstruction = false;
        building.hp = building.maxHp;
        ctx.eventBus.emit('buildingCompleted', { building });
      }
      continue;
    }

    if (building.queue.length === 0) continue;
    const job = building.queue[0];
    job.timeLeft -= dt;
    if (job.timeLeft > 0) continue;

    building.queue.shift();
    if (job.kind === 'unit') spawnTrainedUnit(ctx, building, job.id);
    else if (job.kind === 'tech') {
      ctx.players[building.ownerId].researchedTech.add(job.id);
      ctx.eventBus.emit('techResearched', { ownerId: building.ownerId, techId: job.id });
    }
  }
}

function spawnTrainedUnit(ctx, building, unitTypeId) {
  const race = raceOf(ctx, building.ownerId);
  const def = race.units[unitTypeId] || race.heroes?.[unitTypeId];
  const isHero = !!race.heroes?.[unitTypeId];
  const spot = findSpawnSpot(ctx, building);
  const unit = createUnit(ctx.store, { ownerId: building.ownerId, def, x: spot.x, y: spot.y, isHero });
  ctx.eventBus.emit('unitSpawned', { unit, building });

  const rally = building.rallyPoint || { x: spot.x, y: spot.y + 2 };
  if (rally.x !== spot.x || rally.y !== spot.y) moveUnitTo(ctx, unit, rally.x, rally.y);
}

function findSpawnSpot(ctx, building) {
  const { footprint } = building;
  const cx = building.x, cy = building.y + footprint.h / 2 + 0.5;
  for (let r = 0; r < 6; r++) {
    const tx = Math.floor(cx), ty = Math.floor(cy) + r;
    if (ctx.map.grid.isWalkable(tx, ty)) return { x: tx + 0.5, y: ty + 0.5 };
  }
  return { x: cx, y: cy };
}
