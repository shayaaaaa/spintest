import { Transform } from './components.js';

// Display names for map-placed (neutral) resource nodes — not race-specific,
// since the node itself isn't owned by any player.
const RESOURCE_NODE_NAMES = { materials: 'Gold Mine', lumber: 'Tree' };

// Rings around a node's center that harvesting/queued workers stand on —
// tight ring for active harvesters (visibly surrounding the node instead of
// stacking on its center), a wider one further out for workers waiting their
// turn (visibly standing back rather than overlapping the active ones).
const HARVEST_RING_RADIUS = 0.9;
const QUEUE_RING_RADIUS = 1.7;

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

// A point on the wider ring for a worker waiting at `queueIndex` in the
// node's wait queue, spread across however many are currently waiting.
export function queueSlotPoint(node, queueIndex) {
  const count = Math.max(node.waitQueue.length, 1);
  const angle = (queueIndex / count) * Math.PI * 2 + Math.PI / count; // offset from the harvest ring's angles
  return { x: node.x + Math.cos(angle) * QUEUE_RING_RADIUS, y: node.y + Math.sin(angle) * QUEUE_RING_RADIUS };
}
