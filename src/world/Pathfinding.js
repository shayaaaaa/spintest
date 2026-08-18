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

function nearestWalkableNeighbor(grid, tx, ty, fromX, fromY) {
  let best = null, bestDist = Infinity;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dy === 0) continue;
      const nx = tx + dx, ny = ty + dy;
      if (!grid.isWalkable(nx, ny)) continue;
      const d = (nx - fromX) ** 2 + (ny - fromY) ** 2;
      if (d < bestDist) { bestDist = d; best = { tx: nx, ty: ny }; }
    }
  }
  return best;
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
