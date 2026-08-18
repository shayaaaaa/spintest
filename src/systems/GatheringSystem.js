import { moveUnitTo } from './MovementSystem.js';
import { canHarvest } from '../entities/ResourceNode.js';

const HARVEST_SECONDS_PER_LOAD = 4;
const DEPOSIT_SECONDS = 0.5;

export function issueGatherOrder(ctx, unit, node) {
  if (!unit.canGather) return;
  unit.order = { type: 'gather', nodeId: node.id };
  unit.gatherTimer = 0;
  moveUnitTo(ctx, unit, node.x, node.y, (ctx2, u) => beginHarvest(ctx2, u, node));
}

function beginHarvest(ctx, unit, node) {
  if (unit.cargoAmount > 0 && unit.cargoType !== node.resourceType) {
    // Switching resource types with cargo held: deposit first.
    return goToDropoff(ctx, unit);
  }
  if (!canHarvest(node) || node.amount <= 0) {
    unit.state = 'idle';
    unit.order = null;
    return;
  }
  node.harvesterIds.add(unit.id);
  unit.state = 'gathering';
  unit.gatherTimer = HARVEST_SECONDS_PER_LOAD;
  unit.gatherNodeId = node.id;
  unit.cargoType = node.resourceType;
}

function goToDropoff(ctx, unit) {
  const dropoff = nearestDropoff(ctx, unit);
  if (!dropoff) { unit.state = 'idle'; return; }
  unit.state = 'movingToDropoff';
  moveUnitTo(ctx, unit, dropoff.x, dropoff.y, (ctx2, u) => beginDeposit(ctx2, u, dropoff));
}

function beginDeposit(ctx, unit, dropoff) {
  unit.state = 'depositing';
  unit.depositTimer = DEPOSIT_SECONDS;
  unit.depositBuildingId = dropoff.id;
}

function nearestDropoff(ctx, unit) {
  let best = null, bestDist = Infinity;
  for (const b of ctx.store.buildingsOf(unit.ownerId)) {
    if (b.underConstruction) continue;
    if (!(b.trains?.length || b.isTownHall)) continue; // town hall / production buildings act as drop-off
    const d = Math.hypot(b.x - unit.x, b.y - unit.y);
    if (d < bestDist) { bestDist = d; best = b; }
  }
  return best;
}

export function updateGathering(ctx, dt) {
  for (const unit of ctx.store.all) {
    if (unit.kind !== 'unit') continue;

    if (unit.state === 'gathering') {
      unit.gatherTimer -= dt;
      if (unit.gatherTimer <= 0) {
        const node = ctx.store.get(unit.gatherNodeId);
        const rate = unit.cargoCapacity / HARVEST_SECONDS_PER_LOAD;
        const want = unit.cargoCapacity - unit.cargoAmount;
        const available = node ? node.amount : 0;
        const take = Math.min(want, available, unit.cargoCapacity);
        unit.cargoAmount = Math.min(unit.cargoCapacity, unit.cargoAmount + Math.max(take, 0));
        if (node) node.amount = Math.max(0, node.amount - take);

        const nodeExhausted = !node || node.amount <= 0;
        if (unit.cargoAmount >= unit.cargoCapacity || nodeExhausted) {
          if (node) node.harvesterIds.delete(unit.id);
          goToDropoff(ctx, unit);
        } else {
          unit.gatherTimer = HARVEST_SECONDS_PER_LOAD; // keep harvesting same node
        }
      }
    } else if (unit.state === 'depositing') {
      unit.depositTimer -= dt;
      if (unit.depositTimer <= 0) {
        const player = ctx.players[unit.ownerId];
        if (player) player.resources[unit.cargoType] = (player.resources[unit.cargoType] || 0) + unit.cargoAmount;
        ctx.eventBus.emit('resourcesChanged', { ownerId: unit.ownerId });
        unit.cargoAmount = 0;
        const node = unit.gatherNodeId ? ctx.store.get(unit.gatherNodeId) : null;
        if (node && node.amount > 0) beginHarvest(ctx, unit, node);
        else { unit.state = 'idle'; unit.order = null; }
      }
    }
  }
}
