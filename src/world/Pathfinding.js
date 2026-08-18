// A* pathfinding over a Grid, 8-directional with corner-cut prevention.
// Requests queue and drain a limited number per tick so a large box-select
// move doesn't spike one frame with dozens of full searches.

class MinHeap {
  constructor() { this.items = []; }
  get size() { return this.items.length; }
  push(item, priority) {
    this.items.push({ item, priority });
    let i = this.items.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.items[parent].priority <= this.items[i].priority) break;
      [this.items[parent], this.items[i]] = [this.items[i], this.items[parent]];
      i = parent;
    }
  }
  pop() {
    const top = this.items[0];
    const last = this.items.pop();
    if (this.items.length > 0) {
      this.items[0] = last;
      let i = 0;
      while (true) {
        const l = i * 2 + 1, r = i * 2 + 2;
        let smallest = i;
        if (l < this.items.length && this.items[l].priority < this.items[smallest].priority) smallest = l;
        if (r < this.items.length && this.items[r].priority < this.items[smallest].priority) smallest = r;
        if (smallest === i) break;
        [this.items[smallest], this.items[i]] = [this.items[i], this.items[smallest]];
        i = smallest;
      }
    }
    return top?.item;
  }
}

const NEIGHBORS = [
  [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
  [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2],
];

function heuristic(ax, ay, bx, by) {
  const dx = Math.abs(ax - bx), dy = Math.abs(ay - by);
  return Math.max(dx, dy) + (Math.SQRT2 - 1) * Math.min(dx, dy); // octile
}

// Finds a tile path from (sx,sy) to (gx,gy). Returns array of {tx,ty} or null.
// maxNodes bounds worst-case search cost on large empty maps.
export function findPath(grid, sx, sy, gx, gy, maxNodes = 2000) {
  if (!grid.isWalkable(gx, gy)) {
    // Target blocked (e.g. attacking a building) — path to nearest walkable neighbor instead.
    const alt = nearestWalkableNeighbor(grid, gx, gy, sx, sy);
    if (!alt) return null;
    gx = alt.tx; gy = alt.ty;
  }
  if (sx === gx && sy === gy) return [];

  const open = new MinHeap();
  const key = (x, y) => y * grid.width + x;
  const gScore = new Map([[key(sx, sy), 0]]);
  const cameFrom = new Map();
  const closed = new Set();
  open.push({ x: sx, y: sy }, heuristic(sx, sy, gx, gy));
  let visited = 0;

  while (open.size > 0 && visited < maxNodes) {
    const cur = open.pop();
    const curKey = key(cur.x, cur.y);
    if (closed.has(curKey)) continue;
    closed.add(curKey);
    visited++;

    if (cur.x === gx && cur.y === gy) return reconstruct(cameFrom, cur, key);

    for (const [dx, dy, cost] of NEIGHBORS) {
      const nx = cur.x + dx, ny = cur.y + dy;
      if (!grid.isWalkable(nx, ny)) continue;
      // Prevent cutting across a blocked corner diagonally.
      if (dx !== 0 && dy !== 0) {
        if (!grid.isWalkable(cur.x + dx, cur.y) || !grid.isWalkable(cur.x, cur.y + dy)) continue;
      }
      const nKey = key(nx, ny);
      if (closed.has(nKey)) continue;
      const tentative = gScore.get(curKey) + cost;
      if (tentative < (gScore.get(nKey) ?? Infinity)) {
        gScore.set(nKey, tentative);
        cameFrom.set(nKey, cur);
        open.push({ x: nx, y: ny }, tentative + heuristic(nx, ny, gx, gy));
      }
    }
  }
  return null; // no path found within budget
}

function reconstruct(cameFrom, endNode, key) {
  const path = [{ tx: endNode.x, ty: endNode.y }];
  let curKey = key(endNode.x, endNode.y);
  let node = endNode;
  while (cameFrom.has(curKey)) {
    node = cameFrom.get(curKey);
    curKey = key(node.x, node.y);
    path.push({ tx: node.x, ty: node.y });
  }
  path.reverse();
  return smooth(path);
}

// Simple string-pulling: drop intermediate waypoints that are collinear
// (keeps zig-zag tile-steps from being visibly jagged).
function smooth(path) {
  if (path.length < 3) return path;
  const out = [path[0]];
  for (let i = 1; i < path.length - 1; i++) {
    const a = out[out.length - 1], b = path[i], c = path[i + 1];
    const d1x = b.tx - a.tx, d1y = b.ty - a.ty;
    const d2x = c.tx - b.tx, d2y = c.ty - b.ty;
    const sameDir = Math.sign(d1x) === Math.sign(d2x) && Math.sign(d1y) === Math.sign(d2y);
    if (!sameDir) out.push(b);
  }
  out.push(path[path.length - 1]);
  return out;
}

// Scans progressively wider rings around the (blocked) target tile until a
// walkable one turns up. A fixed 1-tile ring isn't enough for anything with
// a footprint bigger than 1x1 — e.g. a 3x3 building's immediate ring is
// entirely its own footprint — so this expands outward instead of giving up.
//
// Within the first ring that has any candidate, tiles are ranked by how
// tightly they hug the target first (closest to tx,ty), and only tie-broken
// by distance to the walker. A same-radius ring mixes corner tiles (~1.4x
// farther from the target in a straight line) with edge tiles directly
// against it — always taking whichever is nearest the walker would send
// units to the diagonally-nearest corner even when a flush edge tile is
// barely any further to walk to, leaving a visibly bigger gap than
// necessary once they arrive.
function nearestWalkableNeighbor(grid, tx, ty, fromX, fromY, maxRadius = 6) {
  for (let radius = 1; radius <= maxRadius; radius++) {
    const candidates = [];
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== radius) continue; // only this ring's new tiles
        const nx = tx + dx, ny = ty + dy;
        if (grid.isWalkable(nx, ny)) candidates.push({ tx: nx, ty: ny });
      }
    }
    if (candidates.length === 0) continue;
    candidates.sort((a, b) => {
      const hugA = (a.tx - tx) ** 2 + (a.ty - ty) ** 2;
      const hugB = (b.tx - tx) ** 2 + (b.ty - ty) ** 2;
      if (hugA !== hugB) return hugA - hugB;
      const walkA = (a.tx - fromX) ** 2 + (a.ty - fromY) ** 2;
      const walkB = (b.tx - fromX) ** 2 + (b.ty - fromY) ** 2;
      return walkA - walkB;
    });
    return candidates[0];
  }
  return null;
}

// Queue that drains a limited number of path requests per sim tick.
export class PathRequestQueue {
  constructor(grid, budgetPerTick = 6) {
    this.grid = grid;
    this.budgetPerTick = budgetPerTick;
    this.queue = [];
  }

  request(sx, sy, gx, gy, onDone) {
    this.queue.push({ sx, sy, gx, gy, onDone });
  }

  drain() {
    let n = 0;
    while (this.queue.length > 0 && n < this.budgetPerTick) {
      const req = this.queue.shift();
      const path = findPath(this.grid, req.sx, req.sy, req.gx, req.gy);
      req.onDone(path);
      n++;
    }
  }
}
