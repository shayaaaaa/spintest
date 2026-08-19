import { moveUnitTo } from './MovementSystem.js';
import { canHarvest, harvestSlotPoint, queueLinePoint, queueLanePoint, queueLineCoords, resetQueuePlaces, QUEUE_LANE_TOLERANCE } from '../entities/ResourceNode.js';

// Halfway to the next row: above this a place belongs to a folded-back row.
const QUEUE_OUTER_ROW_LATERAL = 0.45;

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
  unit.queueAheadId = null; // heading for the node itself now, not queued behind anyone
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

// Direction from the node continuing the line drawn from the unit's owner's
// Townhall through the node — i.e. straight out the far side of the node
// from home base. Falls back to pointing toward the unit itself if no
// Townhall can be found (e.g. it's been destroyed), so a line still forms.
function lineAngleAwayFromHome(ctx, unit, node) {
  let townhall = null;
  for (const b of ctx.store.buildingsOf(unit.ownerId)) {
    if (b.isTownHall && !b.underConstruction) { townhall = b; break; }
  }
  if (!townhall) return Math.atan2(unit.y - node.y, unit.x - node.x);
  return Math.atan2(node.y - townhall.y, node.x - townhall.x);
}

// No open slot: join the wait line — a single-file queue trailing away from
// the node, like a checkout line — and wait. Purely passive — updateGathering
// does nothing for a queued unit; it's woken up by promoteFromQueue whenever
// an active harvester's slot frees, and reflowQueueLine below re-walks it
// forward whenever the line ahead of it shortens.
function enqueue(ctx, unit, node) {
  unit.gatherNodeId = node.id;
  unit.gatherSlot = undefined;
  unit.state = 'gatherQueued';
  if (node.waitQueue.length === 0) {
    // This joiner establishes which way the line trails. Point it away from
    // the player's Townhall (continuing the townhall->node line past the
    // node) rather than back toward wherever this unit happened to approach
    // from — workers usually approach a resource FROM their Townhall, so
    // "toward the joiner" sends the line sprawling back across the same
    // ground units already walk to get here, cutting across the middle of
    // the base. Anchoring away from home keeps the line tucked beside the
    // node instead, and is deterministic rather than depending on which
    // unit happens to join first.
    node.queueLineAngle = lineAngleAwayFromHome(ctx, unit, node);
    resetQueuePlaces(node);
  }
  node.waitQueue.push(unit.id);
  walkToLineSpot(ctx, unit, node, node.waitQueue.length - 1);
}

// Sends `unit` to line position `index`, choosing between two ways of getting
// there.
//
// A worker already standing in the line just walks straight to its new spot:
// during a reflow everybody steps forward one place at once, in the same
// direction and keeping the same gap, so a convoy like that never crosses
// itself. A worker still on its way to the line is the problem case — coming
// from the Townhall it would otherwise walk the whole length of the queue and
// through every worker in it — so it is routed to a staging point out on the
// flank first and steps in sideways from there. See QUEUE_LANE_OFFSET.
function walkToLineSpot(ctx, unit, node, index) {
  // Who this worker is queued behind, so it can hold its distance rather than
  // walking into them — see QUEUE_FOLLOW_GAP in MovementSystem.
  // Whoever this worker should hold its distance behind. For the front of the
  // line that is the worker just promoted out of it: that one is still standing
  // on the front place while it walks off to the node, and without this the new
  // front walks straight onto the spot it has not vacated yet — with a busy
  // mine promoting every few seconds, that handoff is where the queue spends
  // most of its time. The reference goes stale harmlessly, since the brake only
  // acts on someone actually ahead and within following distance.
  unit.queueAheadId = index > 0 ? node.waitQueue[index - 1] : (node.lastPromotedId ?? null);
  const spot = queueLinePoint(node, index, ctx.map.grid);
  const arriveInLine = (ctx2, u) => { u.state = 'gatherQueued'; };
  const here = queueLineCoords(node, unit.x, unit.y);
  const there = queueLineCoords(node, spot.x, spot.y);
  const targetAlong = there.along;
  // The line is one-way traffic: it only ever flows *inward*, because reflow
  // exclusively moves people closer to the node. So a worker whose place is
  // further out than where it currently stands — a returning worker rejoining
  // at the back, most often — would be travelling against that flow and meet
  // the whole queue head-on. Measured in the live game, that was every one of
  // the deepest remaining overlaps. Outward moves therefore always take the
  // flanking lane, and only inward moves use the line itself.
  const goingOutward = targetAlong > here.along + 0.15;
  const inLine = !goingOutward && Math.abs(here.lateral - there.lateral) <= QUEUE_LANE_TOLERANCE;
  if (inLine) {
    moveUnitTo(ctx, unit, spot.x, spot.y, arriveInLine);
    return;
  }
  // Which flank to stage on. For a place in the first row, whichever side the
  // worker is already nearest, so joining the lane never means crossing the
  // line to reach it. For a place in a folded-back row, always from beyond the
  // stack instead: a worker coming from the Townhall is level with the first
  // row, so going by the side it stands on would stage it on the far side of
  // the line from its own place and march it across every row in between —
  // measured as the cause of every overlap left once queues grow past one row.
  // Both rules are needed; using the row rule alone regresses single-row
  // queues, which the near-side rule already handles cleanly.
  const side = there.lateral > QUEUE_OUTER_ROW_LATERAL
    ? 1                                                     // folded-back row: come from beyond the stack
    : (Math.abs(here.lateral - there.lateral) > 0.3 ? Math.sign(here.lateral - there.lateral) : 1);
  const lane = queueLanePoint(node, index, side, ctx.map.grid);
  moveUnitTo(ctx, unit, lane.x, lane.y, (ctx2, u) => {
    moveUnitTo(ctx2, u, spot.x, spot.y, arriveInLine);
  });
}

// Re-walks every unit still in the wait line to its current position —
// call after anything changes node.waitQueue's contents, so whoever's
// behind a gap that opened up (front promoted, or someone in the middle
// left) visibly steps forward to close it, the way a checkout line
// shuffles up when the person at the front is served.
function reflowQueueLine(ctx, node) {
  if (node.waitQueue.length === 0) {
    node.queueLineAngle = null; // next queue that forms here picks a fresh direction
    resetQueuePlaces(node);
    return;
  }
  node.waitQueue.forEach((unitId, index) => {
    const u = ctx.store.get(unitId);
    if (!u) return;
    walkToLineSpot(ctx, u, node, index);
  });
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
    // enqueue() briefly sets state to 'moving' for the short walk to its
    // line spot, so a unit mid-walk would get treated as stale and
    // skipped here — except it's already been shift()-ed off the queue,
    // so it would never be promoted at all, stuck forever once its walk
    // finishes and state flips back to 'gatherQueued'.
    if (!next || next.gatherNodeId !== node.id) continue; // stale entry (dead / reassigned)
    if (node.amount <= 0) { next.state = 'idle'; next.order = null; next.gatherNodeId = null; continue; }
    node.lastPromotedId = next.id; // the new front yields to it while it clears the spot
    grantHarvestSlot(ctx, next, node);
    reflowQueueLine(ctx, node); // everyone still waiting steps forward to close the gap
    return;
  }
  reflowQueueLine(ctx, node); // queue may have shrunk from skipped stale entries even with no promotion
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
      reflowQueueLine(ctx, node); // whoever was behind this unit steps forward
    }
  }
  unit.gatherNodeId = null;
  unit.gatherSlot = undefined;
  unit.queueAheadId = null;
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
