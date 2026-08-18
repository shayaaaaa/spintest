import { moveUnitTo } from './MovementSystem.js';
import { canHarvest, harvestSlotPoint, queueSlotPoint } from '../entities/ResourceNode.js';

const HARVEST_SECONDS_PER_LOAD = 4;
const DEPOSIT_SECONDS = 0.5;

export function issueGatherOrder(ctx, unit, node) {
  if (!unit.canGather) return;
  leaveGatherNode(ctx, unit); // drop any previous reservation/queue spot before taking a new one
  unit.order = { type: 'gather', nodeId: node.id };
  unit.gatherTimer = 0;
  travelToNodeAndHarvest(ctx, unit, node);
}

// Always routes through movement before harvesting — used both for the
// initial order and for every repeat trip after a deposit, so a unit can
// never start "harvesting" from wherever it happens to be standing (e.g.
// still at the drop-off building).
function travelToNodeAndHarvest(ctx, unit, node) {
  // moveUnitTo sets state to 'moving' for the trip; arriveAtNode (the
  // onArrive callback) claims a harvest slot or joins the queue once the
  // unit reaches the node's general vicinity.
  moveUnitTo(ctx, unit, node.x, node.y, (ctx2, u) => arriveAtNode(ctx2, u, node));
}

function arriveAtNode(ctx, unit, node) {
  if (unit.cargoAmount > 0 && unit.cargoType !== node.resourceType) {
    // Switching resource types with cargo held: deposit first.
    return goToDropoff(ctx, unit);
  }
  if (node.amount <= 0) {
    unit.state = 'idle';
    unit.order = null;
    return;
  }
  if (canHarvest(node)) {
    grantHarvestSlot(ctx, unit, node);
  } else {
    enqueue(ctx, unit, node);
  }
}

// Reserves a harvest-ring slot for `unit` and sends it the short remaining
// distance from the node's center out to that slot's point — this is what
// actually spreads workers around the node instead of stacking them on its
// center. The harvest timer only starts once the unit reaches its slot.
function grantHarvestSlot(ctx, unit, node) {
  const slot = freeSlotIndex(node);
  node.harvesterIds.add(unit.id);
  node.harvestSlots[slot] = unit.id;
  unit.gatherNodeId = node.id;
  unit.gatherSlot = slot;
  unit.cargoType = node.resourceType;
  const pt = harvestSlotPoint(node, slot);
  moveUnitTo(ctx, unit, pt.x, pt.y, (ctx2, u) => {
    u.state = 'gathering';
    u.gatherTimer = HARVEST_SECONDS_PER_LOAD;
  });
}

function freeSlotIndex(node) {
  for (let i = 0; i < node.maxHarvesters; i++) if (!node.harvestSlots[i]) return i;
  return 0; // shouldn't happen — caller already checked canHarvest()
}

// No open slot: join the queue and wait at a nearby ring point. Purely
// passive — updateGathering does nothing for a queued unit; it's woken up
// by promoteFromQueue whenever an active harvester's slot frees.
function enqueue(ctx, unit, node) {
  unit.gatherNodeId = node.id;
  unit.gatherSlot = undefined;
  unit.state = 'gatherQueued';
  node.waitQueue.push(unit.id);
  const pt = queueSlotPoint(node, node.waitQueue.length - 1);
  moveUnitTo(ctx, unit, pt.x, pt.y, (ctx2, u) => { u.state = 'gatherQueued'; });
}

// Hands a freed harvest slot to whoever's been waiting longest, skipping
// anyone who died or was reassigned elsewhere since they queued.
function promoteFromQueue(ctx, node) {
  while (node.waitQueue.length > 0 && canHarvest(node)) {
    const nextId = node.waitQueue.shift();
    const next = ctx.store.get(nextId);
    if (!next || next.gatherNodeId !== node.id || next.state !== 'gatherQueued') continue; // stale entry
    if (node.amount <= 0) { next.state = 'idle'; next.order = null; next.gatherNodeId = null; continue; }
    grantHarvestSlot(ctx, next, node);
    return;
  }
}

// Removes a unit from whatever node it's currently reserved at (actively
// harvesting or waiting in the queue), if any — called whenever a unit is
// given a different order, so a stale reservation never sits around
// "holding a slot" for a unit that isn't coming back.
export function leaveGatherNode(ctx, unit) {
  const node = unit.gatherNodeId ? ctx.store.get(unit.gatherNodeId) : null;
  if (node) {
    if (node.harvesterIds.delete(unit.id)) {
      if (unit.gatherSlot !== undefined) node.harvestSlots[unit.gatherSlot] = null;
      promoteFromQueue(ctx, node); // this slot is free now — offer it to the next in line
    } else {
      const qi = node.waitQueue.indexOf(unit.id);
      if (qi !== -1) node.waitQueue.splice(qi, 1);
    }
  }
  unit.gatherNodeId = null;
  unit.gatherSlot = undefined;
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
  // Only the Townhall accepts deposits — any other qualifying building
  // being picked instead reads as "the worker isn't traveling anywhere"
  // whenever one happens to be built near a resource.
  let best = null, bestDist = Infinity;
  for (const b of ctx.store.buildingsOf(unit.ownerId)) {
    if (b.underConstruction || !b.isTownHall) continue;
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
        const want = unit.cargoCapacity - unit.cargoAmount;
        const available = node ? node.amount : 0;
        const take = Math.min(want, available, unit.cargoCapacity);
        unit.cargoAmount = Math.min(unit.cargoCapacity, unit.cargoAmount + Math.max(take, 0));
        if (node) node.amount = Math.max(0, node.amount - take);

        const nodeExhausted = !node || node.amount <= 0;
        if (unit.cargoAmount >= unit.cargoCapacity || nodeExhausted) {
          if (node) {
            node.harvesterIds.delete(unit.id);
            if (unit.gatherSlot !== undefined) node.harvestSlots[unit.gatherSlot] = null;
            unit.gatherSlot = undefined;
            promoteFromQueue(ctx, node);
          }
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
        if (node && node.amount > 0) travelToNodeAndHarvest(ctx, unit, node);
        else { unit.state = 'idle'; unit.order = null; }
      }
    }
    // 'gatherQueued' units are passive — promoteFromQueue wakes them up.
  }
}
