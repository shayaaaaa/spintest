// Tile grid: walkability mask + world<->tile coordinate conversion.
// One tile = 1 world unit for simplicity.
export const TILE_SIZE = 32; // pixels at zoom = 1

export class Grid {
  constructor(width, height) {
    this.width = width;
    this.height = height;
    // 0 = walkable, 1 = blocked (terrain or building footprint)
    this.blocked = new Uint8Array(width * height);
  }

  inBounds(tx, ty) {
    return tx >= 0 && ty >= 0 && tx < this.width && ty < this.height;
  }

  index(tx, ty) {
    return ty * this.width + tx;
  }

  isWalkable(tx, ty) {
    if (!this.inBounds(tx, ty)) return false;
    return this.blocked[this.index(tx, ty)] === 0;
  }

  setBlocked(tx, ty, blocked) {
    if (!this.inBounds(tx, ty)) return;
    this.blocked[this.index(tx, ty)] = blocked ? 1 : 0;
  }

  setRectBlocked(tx, ty, w, h, blocked) {
    for (let y = ty; y < ty + h; y++) {
      for (let x = tx; x < tx + w; x++) this.setBlocked(x, y, blocked);
    }
  }

  worldToTile(wx, wy) {
    return { tx: Math.floor(wx), ty: Math.floor(wy) };
  }

  tileToWorldCenter(tx, ty) {
    return { x: tx + 0.5, y: ty + 0.5 };
  }
}
