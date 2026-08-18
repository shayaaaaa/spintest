import { moveUnitTo } from './MovementSystem.js';
import { canHarvest, harvestSlotPoint, queueSlotPoint } from '../entities/ResourceNode.js';

const HARVEST_SECONDS_PER_LOAD = 4;
const DEPOSIT_SECONDS = 0.5;

export function issueGatherOrder(ctx, unit, node) {
  if (!unit.canGather) return;
  leaveGatherNode(ctx, unit); // drop any previous reservation/queue spot before taking a new one
  unit.order = { type: 'gather', nodeId: node.id };
  unit.gatherTimer = 0;
  routeToNode(ctx, unit, node);
}

// Decides where a unit heading for `node` should actually walk to and sends
// it straight there — used both for the initial order and for every repeat
// trip after a deposit. Deliberately never routes through the node's own
// center point: if multiple workers are sent to the same node, sending them
// all toward that one shared coordinate first (even briefly) recreates the
// same "several units converging on one exact spot" instability that made
// single-unit movement oscillate a few rounds ago — just with a crowd. Each
// unit's own harvest-slot or queue-ring point (both already distinct per
// unit) is resolved immediately and used as the one and only movement
// target, so no two units traveling to the same node are ever headed to the
// same place at the same time.
function routeToNode(ctx, unit, node) {
  if (unit.cargoAmount > 0 && unit.cargoType !== node.resourceType) {
    // Switching resource types with cargo held: deposit first, then resume
    // toward this node from updateGathering's deposit-complete branch.
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

// Reserves a harvest-ring slot for `unit` and sends it straight there —
// this is what actually spreads workers around the node instead of
// stacking them on its center. The harvest timer only starts once the
// unit reaches its slot.
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
  node.queueSeq = (node.queueSeq || 0) + 1;
  const pt = queueSlotPoint(node, node.queueSeq);
  moveUnitTo(ctx, unit, pt.x, pt.y, (ctx2, u) => { u.state = 'gatherQueued'; });
}

// Hands a freed harvest slot to whoever's been waiting longest, skipping
// anyone who died or was reassigned elsewhere since they queued.
function promoteFromQueue(ctx, node) {
  while (node.waitQueue.length > 0 && canHarvest(node)) {
    const nextId = node.waitQueue.shift();
    const next = ctx.store.get(nextId);
    // A unit still listed in node.waitQueue is — by construction — still
    // validly reserved for this node: leaveGatherNode (called on every
    // reassignment and on death) is the only other thing that ever removes
    // an entry, so membership here already means "still wants this node".
    // Checking live `state` on top of that is wrong, not just redundant:
    // enqueue() briefly sets state to 'moving' for the short walk out to
    // the queue ring point, so a unit mid-walk would get treated as stale
    // and skipped here — except it's already been shift()-ed off the
    // queue, so it would never be promoted at all, stuck forever once its
    // walk finishes and state flips back to 'gatherQueued'.
    if (!next || next.gatherNodeId !== node.id) continue; // stale entry (dead / reassigned)
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
        if (node && node.amount > 0) routeToNode(ctx, unit, node);
        else { unit.state = 'idle'; unit.order = null; }
      }
    }
    // 'gatherQueued' units are passive — promoteFromQueue wakes them up.
  }
}
