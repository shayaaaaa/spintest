import { Transform } from './components.js';

// Display names for map-placed (neutral) resource nodes — not race-specific,
// since the node itself isn't owned by any player.
const RESOURCE_NODE_NAMES = { materials: 'Gold Mine', lumber: 'Tree' };

// Rings around a node's center that harvesting/queued workers stand on —
// tight ring for active harvesters (visibly surrounding the node instead of
// stacking on its center), a wider one further out for workers waiting their
// turn (visibly standing back rather than overlapping the active ones).
//
// Radii need to be big enough that adjacent slots land on well-separated
// map tiles, not just distinct continuous points — movement snaps to tile
// centers, and a unit crossing near an *already-occupied* neighboring tile
// on its way to its own (different) tile gets stuck fighting that
// stationary neighbor's separation push, since separation only tapers off
// near a unit's own final waypoint, not any tile it merely passes close to.
// At the old radius (0.9) adjacent harvest slots could floor to tiles close
// enough that a returning worker's path would cut directly past a
// neighbor's parked spot. 1.5 keeps slots on tiles that are never adjacent.
const HARVEST_RING_RADIUS = 1.5;
const QUEUE_RING_RADIUS = 2.4;
// Fixed pool of queue-ring positions, reused the same way harvest slots
// are (first free index, freed again once its occupant leaves) rather than
// an ever-growing sequence number. An earlier version used the golden angle
// so positions would never *exactly* repeat as the queue grows and shrinks
// over a session — but the golden angle's own defining property is that it
// makes *close* recurrences at Fibonacci-numbered step gaps (13, 21, 34,
// 55...), and those recurrences get closer the further into the sequence
// you go. Across a long session at one busy node, queueSeq climbs well
// past those gaps, and two workers queued that far apart can end up well
// inside separation range of each other. A small fixed, evenly-divided
// pool has a guaranteed minimum spacing that never degrades, however long
// the session runs or however many workers cycle through the queue —
// 12 is comfortably more than would ever realistically queue at one node
// (the whole match's population cap is 20 workers total).
const QUEUE_POOL_SIZE = 12;

// Finite harvestable node with a max concurrent-harvester slot count —
// prevents workers stacking on one node and creates expansion pressure.
export function createResourceNode(store, { resourceType, amount, x, y, maxHarvesters = 3 }) {
  const entity = {
    kind: 'resourceNode',
    resourceType, // 'materials' | 'lumber'
    name: RESOURCE_NODE_NAMES[resourceType] || 'Resource',
    amount,
    maxAmount: amount,
    maxHarvesters,
    harvesterIds: new Set(),
    harvestSlots: new Array(maxHarvesters).fill(null), // slot index -> unit id
    waitQueue: [], // unit ids waiting for a free slot, FIFO (first arrived, first served)
    queueSlots: new Array(QUEUE_POOL_SIZE).fill(null), // slot index -> unit id, for queueSlotPoint
    ...Transform(x, y),
  };
  return store.add(entity);
}

export function canHarvest(node) {
  return node.amount > 0 && node.harvesterIds.size < node.maxHarvesters;
}

// A point on the tight ring around the node that an active harvester in
// `slotIndex` should stand on, spread evenly around the full circle.
export function harvestSlotPoint(node, slotIndex) {
  const angle = (slotIndex / node.maxHarvesters) * Math.PI * 2;
  return { x: node.x + Math.cos(angle) * HARVEST_RING_RADIUS, y: node.y + Math.sin(angle) * HARVEST_RING_RADIUS };
}

// Finds a free index in the node's fixed queue-position pool (mirrors
// harvestSlotPoint's freeSlotIndex in GatheringSystem.js). Wraps modulo in
// the extreme case every pool slot is somehow occupied at once, rather
// than crashing — acceptable degradation for a case that shouldn't happen
// given the pool is sized well above the game's population cap.
export function freeQueueSlotIndex(node) {
  for (let i = 0; i < node.queueSlots.length; i++) if (!node.queueSlots[i]) return i;
  return Math.floor(Math.random() * node.queueSlots.length);
}

// A point on the wider ring for pool slot `slotIndex`, spread evenly
// around the full circle — see QUEUE_POOL_SIZE.
export function queueSlotPoint(node, slotIndex) {
  const angle = (slotIndex / QUEUE_POOL_SIZE) * Math.PI * 2;
  return { x: node.x + Math.cos(angle) * QUEUE_RING_RADIUS, y: node.y + Math.sin(angle) * QUEUE_RING_RADIUS };
}
