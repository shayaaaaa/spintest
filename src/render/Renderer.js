import { drawTerrain } from './layers/TerrainLayer.js';
import { drawFog } from './layers/FogLayer.js';
import { drawEntities } from './layers/EntityLayer.js';
import { drawSelection, drawDragBox } from './layers/SelectionLayer.js';
import { drawEffects, drawBuildGhost, drawTargetReticle } from './layers/EffectsLayer.js';

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx2d = canvas.getContext('2d');
  }

  resize(w, h, dpr) {
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    this.ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  // gameCtx: engine context; view: { camera, selection, effectsState,
  // dragBox, buildGhost, targetReticle }
  render(gameCtx, view) {
    const { camera } = view;
    const ctx2d = this.ctx2d;

    drawTerrain(ctx2d, camera, gameCtx.map, gameCtx.time);
    drawEntities(ctx2d, camera, gameCtx);
    drawSelection(ctx2d, camera, gameCtx, view.selection);
    drawEffects(ctx2d, camera, view.effectsState);
    if (view.buildGhost) drawBuildGhost(ctx2d, camera, view.buildGhost);
    if (view.targetReticle) drawTargetReticle(ctx2d, camera, view.targetReticle.x, view.targetReticle.y);
    drawFog(ctx2d, camera, gameCtx.fogByOwner[gameCtx.localPlayerId]);
    if (view.dragBox) drawDragBox(ctx2d, view.dragBox);
  }
}
