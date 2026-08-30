// Coarse uniform-grid spatial index, rebuilt once per sim tick from the
// EntityStore. Shared by movement (local separation), combat (nearest
// enemy queries), and rendering (camera-view culling) so there's one
// broad-phase instead of three ad-hoc scans.
const CELL_SIZE = 4; // in tiles

export class SpatialGrid {
  constructor() {
    this.cells = new Map(); // "cx,cy" -> entity[]
  }

  static cellKey(x, y) {
    return `${Math.floor(x / CELL_SIZE)},${Math.floor(y / CELL_SIZE)}`;
  }

  rebuild(entities) {
    this.cells.clear();
    for (const e of entities) {
      const key = SpatialGrid.cellKey(e.x, e.y);
      if (!this.cells.has(key)) this.cells.set(key, []);
      this.cells.get(key).push(e);
    }
  }

  // Yields entities within `radius` tiles of (x, y) — a superset (cell-
  // granular), caller does the exact distance check.
  *queryRadius(x, y, radius) {
    const minCx = Math.floor((x - radius) / CELL_SIZE);
    const maxCx = Math.floor((x + radius) / CELL_SIZE);
    const minCy = Math.floor((y - radius) / CELL_SIZE);
    const maxCy = Math.floor((y + radius) / CELL_SIZE);
    for (let cy = minCy; cy <= maxCy; cy++) {
      for (let cx = minCx; cx <= maxCx; cx++) {
        const bucket = this.cells.get(`${cx},${cy}`);
        if (!bucket) continue;
        for (const e of bucket) yield e;
      }
    }
  }

  queryRect(minX, minY, maxX, maxY) {
    const out = [];
    const minCx = Math.floor(minX / CELL_SIZE), maxCx = Math.floor(maxX / CELL_SIZE);
    const minCy = Math.floor(minY / CELL_SIZE), maxCy = Math.floor(maxY / CELL_SIZE);
    for (let cy = minCy; cy <= maxCy; cy++) {
      for (let cx = minCx; cx <= maxCx; cx++) {
        const bucket = this.cells.get(`${cx},${cy}`);
        if (!bucket) continue;
        for (const e of bucket) out.push(e);
      }
    }
    return out;
  }
}
