import { Transform } from './components.js';

// Display names for map-placed (neutral) resource nodes — not race-specific,
// since the node itself isn't owned by any player.
const RESOURCE_NODE_NAMES = { materials: 'Gold Mine', lumber: 'Tree' };

// Tight ring around the node that active harvesters stand on — visibly
// surrounding it instead of stacking on its center, like several open
// registers at once. Radius needs to be big enough that adjacent slots land
// on well-separated map tiles, not just distinct continuous points —
// movement snaps intermediate waypoints to tile centers, and a unit
// crossing near an *already-occupied* neighboring tile on its way to its
// own (different) tile gets stuck fighting that stationary neighbor's
// separation push, since separation only tapers off near a unit's own
// final waypoint, not any tile it merely passes close to. At the old
// radius (0.9) adjacent harvest slots could floor to tiles close enough
// that a returning worker's path would cut directly past a neighbor's
// parked spot. 1.5 keeps slots on tiles that are never adjacent.
const HARVEST_RING_RADIUS = 1.5;
// Workers waiting for a slot stand in an actual single-file line trailing
// away from the node, like a checkout queue, instead of scattered around a
// ring — see queueLinePoint. LINE_START clears the harvest ring; LINE_SPACING
// (matching FORMATION_SPACING already used for group-move spacing in
// InputMapper.js) keeps consecutive line spots outside separation range.
// A straight line's positions are index*spacing apart, so unlike any ring
// arrangement, two positions can never end up coincidentally close —
// spacing between them only ever grows with index, never shrinks.
const LINE_START_DISTANCE = 2.0;
const LINE_SPACING = 0.9;

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
    queueLineAngle: null, // direction the wait line trails in — set when the first worker joins an empty queue, cleared when it empties
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

// Position `index` (0 = next up) in the wait line, along node.queueLineAngle
// — caller is responsible for having set that angle first (see enqueue in
// GatheringSystem.js).
export function queueLinePoint(node, index) {
  const dist = LINE_START_DISTANCE + index * LINE_SPACING;
  return { x: node.x + Math.cos(node.queueLineAngle) * dist, y: node.y + Math.sin(node.queueLineAngle) * dist };
}
