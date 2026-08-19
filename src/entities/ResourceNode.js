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
// Must clear HARVEST_RING_RADIUS by at least one unit diameter (0.75): the
// harvest slot and the first queue spot are placed on independent angles, so
// when those angles happen to line up the two workers sit exactly
// LINE_START_DISTANCE - HARVEST_RING_RADIUS apart. At the old 2.0 that gap was
// 0.5 — closer than the sprites are wide, i.e. the harvester and the worker
// first in line drawn on top of each other, depending purely on where the
// node sat relative to the Townhall.
const LINE_START_DISTANCE = 2.4;
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
    queuePlaces: null,    // resolved, walkable standing places along that line (see queueLinePoint)
    queueProbe: 0,
    lastPromotedId: null, // worker most recently promoted out of the queue (see walkToLineSpot)
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
// How many workers stand in one row before the queue folds back alongside
// itself, and how far apart those rows sit. A line that just kept going would
// eventually run off usable ground — on this map a deep queue at the nearest
// mine reaches into the lake by its thirteenth place, and every spot past the
// shore resolves to the same handful of walkable tiles, landing that whole tail
// of the queue on top of each other. Folding keeps every place on open ground,
// and keeps a big queue from sprawling halfway across the map besides. Rows
// alternate direction, so consecutive places stay next to each other and the
// queue still reads as one continuous line doubling back on itself.
const QUEUE_ROW_LENGTH = 8;
const QUEUE_ROW_SPACING = 0.9;

// Nth candidate spot along the folded line, ignoring whether it is usable.
function queueCandidate(node, n) {
  const col = n % QUEUE_ROW_LENGTH;
  const row = Math.floor(n / QUEUE_ROW_LENGTH);
  const along = LINE_START_DISTANCE + (row % 2 === 0 ? col : QUEUE_ROW_LENGTH - 1 - col) * LINE_SPACING;
  const lateral = row * QUEUE_ROW_SPACING;
  const ca = Math.cos(node.queueLineAngle), sa = Math.sin(node.queueLineAngle);
  return { x: node.x + ca * along - sa * lateral, y: node.y + sa * along + ca * lateral };
}

// Where the worker `index` places back in the line should stand.
//
// Candidates that land on unusable ground — a tree, the lake edge — are skipped
// rather than used, because a blocked destination is quietly replaced by the
// nearest walkable tile when the path is built, and several blocked places in a
// row all collapse onto the same few tiles by the shore, parking that whole
// stretch of the queue on top of each other. Skipping leaves a visible gap
// where the obstacle is, which reads as people stepping around it. Results are
// cached per node and thrown away whenever the line's direction is reset.
export function queueLinePoint(node, index, grid) {
  if (!node.queuePlaces) { node.queuePlaces = []; node.queueProbe = 0; }
  while (node.queuePlaces.length <= index) {
    const p = queueCandidate(node, node.queueProbe++);
    // The guard keeps a queue hemmed in by terrain from searching forever; past
    // it, take whatever comes rather than hang.
    if (!grid || grid.isWalkable(Math.floor(p.x), Math.floor(p.y)) || node.queueProbe > QUEUE_PLACE_SEARCH_LIMIT) {
      node.queuePlaces.push(p);
    }
  }
  return node.queuePlaces[index];
}

const QUEUE_PLACE_SEARCH_LIMIT = 200;

// Called whenever the line's direction changes, so stale places aren't reused.
export function resetQueuePlaces(node) {
  node.queuePlaces = null;
  node.queueProbe = 0;
}

// How far to the side the approach lane sits. A queue is a wall: a worker
// heading for the back of it from the Townhall side would otherwise walk the
// entire length of the line and straight through everybody already standing in
// it. Checked geometrically against the real map layout, no straight-line queue
// angle avoids that — the best any angle manages is 0.44 tiles of clearance,
// less than the 0.75 a worker sprite is wide — so instead of crossing the line,
// arrivals walk a lane alongside it and step in sideways at the end. 1.8 is the
// smallest offset that keeps both legs of that trip clear of every occupied
// spot by more than a full worker width (0.86 measured).
const QUEUE_LANE_OFFSET = 1.8;

// The staging point beside line position `index`, on the `side` (+1/-1) flank.
export function queueLanePoint(node, index, side, grid) {
  const spot = queueLinePoint(node, index, grid);
  const perp = node.queueLineAngle + Math.PI / 2;
  return { x: spot.x + Math.cos(perp) * QUEUE_LANE_OFFSET * side, y: spot.y + Math.sin(perp) * QUEUE_LANE_OFFSET * side };
}

// True when the queue's own geometry says (x,y) is already standing in the
// place the line wants it — same distance out, same row.


// Position of (x,y) in the queue's own frame: `along` measures out from the node
// down the line, `lateral` measures off to its side. Used to tell a worker
// already standing in the line (which should just shuffle forward in convoy)
// from one still on its way there (which needs the lane).
export function queueLineCoords(node, x, y) {
  const ca = Math.cos(node.queueLineAngle), sa = Math.sin(node.queueLineAngle);
  const dx = x - node.x, dy = y - node.y;
  return { along: dx * ca + dy * sa, lateral: -dx * sa + dy * ca };
}

// Slack allowed before a worker counts as "off the line" and takes the lane.
export const QUEUE_LANE_TOLERANCE = 0.6;
