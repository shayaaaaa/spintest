// Per-player visibility grid: 0 = hidden, 1 = explored (seen before, dimmed),
// 2 = visible (currently in sight). Recomputed on a timer, not per frame.
export const Visibility = { HIDDEN: 0, EXPLORED: 1, VISIBLE: 2 };

// Precomputed circular offsets per radius so sight checks are just an
// array walk instead of a per-tile distance calc every recompute.
const circleCache = new Map();
function circleOffsets(radius) {
  if (circleCache.has(radius)) return circleCache.get(radius);
  const offsets = [];
  const r2 = radius * radius;
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      if (dx * dx + dy * dy <= r2) offsets.push([dx, dy]);
    }
  }
  circleCache.set(radius, offsets);
  return offsets;
}

export class FogOfWar {
  constructor(width, height) {
    this.width = width;
    this.height = height;
    this.grid = new Uint8Array(width * height).fill(Visibility.HIDDEN);
    this.dirty = true;
  }

  index(tx, ty) {
    return ty * this.width + tx;
  }

  at(tx, ty) {
    if (tx < 0 || ty < 0 || tx >= this.width || ty >= this.height) return Visibility.HIDDEN;
    return this.grid[this.index(tx, ty)];
  }

  // sighters: iterable of { tx, ty, sight }
  recompute(sighters) {
    // Demote currently-visible tiles to explored before re-marking.
    for (let i = 0; i < this.grid.length; i++) {
      if (this.grid[i] === Visibility.VISIBLE) this.grid[i] = Visibility.EXPLORED;
    }
    for (const s of sighters) {
      const offsets = circleOffsets(s.sight);
      for (const [dx, dy] of offsets) {
        const tx = s.tx + dx;
        const ty = s.ty + dy;
        if (tx < 0 || ty < 0 || tx >= this.width || ty >= this.height) continue;
        this.grid[this.index(tx, ty)] = Visibility.VISIBLE;
      }
    }
    this.dirty = true;
  }
}
