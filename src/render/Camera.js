import { TILE_SIZE } from '../world/Grid.js';

const MIN_ZOOM = 0.5;
const MAX_ZOOM = 2.5;

// Camera state in world (tile) units. worldToScreen/screenToWorld are the
// single source of truth used by both rendering and input mapping.
export class Camera {
  constructor(viewportWidth, viewportHeight) {
    this.x = 0; // world-space center, in tiles
    this.y = 0;
    this.zoom = 1;
    this.viewportWidth = viewportWidth;
    this.viewportHeight = viewportHeight;
    this.mapWidth = Infinity;
    this.mapHeight = Infinity;
  }

  resize(w, h) {
    this.viewportWidth = w;
    this.viewportHeight = h;
  }

  setBounds(mapWidth, mapHeight) {
    this.mapWidth = mapWidth;
    this.mapHeight = mapHeight;
  }

  get pixelsPerTile() {
    return TILE_SIZE * this.zoom;
  }

  worldToScreen(wx, wy) {
    const ppt = this.pixelsPerTile;
    return {
      x: (wx - this.x) * ppt + this.viewportWidth / 2,
      y: (wy - this.y) * ppt + this.viewportHeight / 2,
    };
  }

  screenToWorld(sx, sy) {
    const ppt = this.pixelsPerTile;
    return {
      x: (sx - this.viewportWidth / 2) / ppt + this.x,
      y: (sy - this.viewportHeight / 2) / ppt + this.y,
    };
  }

  pan(dxWorld, dyWorld) {
    this.x += dxWorld;
    this.y += dyWorld;
    this.clamp();
  }

  panPixels(dxPx, dyPx) {
    this.pan(-dxPx / this.pixelsPerTile, -dyPx / this.pixelsPerTile);
  }

  // Zoom while keeping the world point currently under (screenX, screenY) fixed.
  zoomAt(screenX, screenY, factor) {
    const before = this.screenToWorld(screenX, screenY);
    this.zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, this.zoom * factor));
    const after = this.screenToWorld(screenX, screenY);
    this.x += before.x - after.x;
    this.y += before.y - after.y;
    this.clamp();
  }

  clamp() {
    if (!isFinite(this.mapWidth)) return;
    const halfW = this.viewportWidth / 2 / this.pixelsPerTile;
    const halfH = this.viewportHeight / 2 / this.pixelsPerTile;
    this.x = Math.min(Math.max(this.x, halfW), Math.max(this.mapWidth - halfW, halfW));
    this.y = Math.min(Math.max(this.y, halfH), Math.max(this.mapHeight - halfH, halfH));
  }

  // Visible world-space rect, with a small margin for culling.
  visibleRect(margin = 2) {
    const tl = this.screenToWorld(0, 0);
    const br = this.screenToWorld(this.viewportWidth, this.viewportHeight);
    return { minX: tl.x - margin, minY: tl.y - margin, maxX: br.x + margin, maxY: br.y + margin };
  }
}
