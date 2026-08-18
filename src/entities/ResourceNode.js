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
// The golden angle — placing successive points this far apart around a
// circle never repeats or clusters regardless of how many points end up
// placed, unlike dividing the circle by however many are queued *right
// now* (which reshuffles every existing point's angle as the queue grows
// or shrinks, and can coincidentally re-land two different points on the
// same angle at different queue sizes).
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

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
    queueSeq: 0, // ever-increasing counter — see queueSlotPoint
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

// A point on the wider ring for the `queueSeq`-th worker ever to queue at
// this node — pass node.queueSeq after incrementing it. Using an
// ever-increasing sequence number instead of the queue's current
// length/index means positions never collide as the queue grows and
// shrinks over a session (see GOLDEN_ANGLE).
export function queueSlotPoint(node, queueSeq) {
  const angle = queueSeq * GOLDEN_ANGLE;
  return { x: node.x + Math.cos(angle) * QUEUE_RING_RADIUS, y: node.y + Math.sin(angle) * QUEUE_RING_RADIUS };
}
