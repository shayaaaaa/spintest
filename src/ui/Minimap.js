import { Visibility } from '../world/FogOfWar.js';

// Simplified minimap: colored dots for units/buildings, a camera viewport
// box, tap-to-recenter.
export class Minimap {
  constructor(ctx, view) {
    this.ctx = ctx;
    this.view = view;
    this.container = document.getElementById('minimap');
    this.canvas = document.createElement('canvas');
    this.canvas.width = 110;
    this.canvas.height = 110;
    this.container.appendChild(this.canvas);
    this.ctx2d = this.canvas.getContext('2d');

    this.canvas.addEventListener('pointerdown', (e) => {
      const r = this.canvas.getBoundingClientRect();
      const nx = (e.clientX - r.left) / r.width;
      const ny = (e.clientY - r.top) / r.height;
      view.camera.x = nx * ctx.map.width;
      view.camera.y = ny * ctx.map.height;
      view.camera.clamp();
    });
  }

  refresh() {
    const { ctx2d } = this;
    const w = this.canvas.width, h = this.canvas.height;
    const mapW = this.ctx.map.width, mapH = this.ctx.map.height;
    const fog = this.ctx.fogByOwner[this.ctx.localPlayerId];

    ctx2d.fillStyle = '#0d1216';
    ctx2d.fillRect(0, 0, w, h);

    for (const e of this.ctx.store.all) {
      if (e.hp === undefined && e.kind !== 'resourceNode') continue;
      const isOwn = e.ownerId === this.ctx.localPlayerId;
      if (!isOwn && e.ownerId !== undefined) {
        const vis = fog ? fog.at(Math.floor(e.x), Math.floor(e.y)) : Visibility.HIDDEN;
        if (vis === Visibility.HIDDEN) continue;
        if (e.kind === 'unit' && vis !== Visibility.VISIBLE) continue;
      }
      const px = (e.x / mapW) * w, py = (e.y / mapH) * h;
      ctx2d.fillStyle = e.kind === 'resourceNode'
        ? (e.resourceType === 'lumber' ? '#5f9e4f' : '#d9b23a')
        : (this.ctx.players[e.ownerId]?.race.color || '#999');
      ctx2d.fillRect(px - 1.5, py - 1.5, 3, 3);
    }

    const rect = this.view.camera.visibleRect(0);
    ctx2d.strokeStyle = 'rgba(255,255,255,0.7)';
    ctx2d.lineWidth = 1;
    ctx2d.strokeRect((rect.minX / mapW) * w, (rect.minY / mapH) * h, ((rect.maxX - rect.minX) / mapW) * w, ((rect.maxY - rect.minY) / mapH) * h);
  }
}
