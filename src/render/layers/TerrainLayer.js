import { Terrain } from '../../world/Map.js';
import { getTreeSprite } from '../sprites/ShapeSprites.js';

const TERRAIN_COLORS = {
  [Terrain.GRASS]: '#3a6b35',
  [Terrain.DIRT]: '#7a5a3a',
  [Terrain.WATER]: '#2a5a86',
  [Terrain.CLIFF]: '#5a5a5a',
};

// Draws only the tiles within the camera's visible rect — cheap enough to
// redraw every frame at typical viewport sizes without an offscreen cache.
export function drawTerrain(ctx2d, camera, map) {
  const rect = camera.visibleRect(1);
  const minTx = Math.max(0, Math.floor(rect.minX));
  const maxTx = Math.min(map.width - 1, Math.ceil(rect.maxX));
  const minTy = Math.max(0, Math.floor(rect.minY));
  const maxTy = Math.min(map.height - 1, Math.ceil(rect.maxY));
  const ppt = camera.pixelsPerTile;

  ctx2d.fillStyle = '#101418';
  ctx2d.fillRect(0, 0, camera.viewportWidth, camera.viewportHeight);

  for (let ty = minTy; ty <= maxTy; ty++) {
    for (let tx = minTx; tx <= maxTx; tx++) {
      const type = map.terrainAt(tx, ty);
      const p = camera.worldToScreen(tx, ty);
      ctx2d.fillStyle = TERRAIN_COLORS[type] || TERRAIN_COLORS[Terrain.GRASS];
      ctx2d.fillRect(Math.floor(p.x), Math.floor(p.y), Math.ceil(ppt) + 1, Math.ceil(ppt) + 1);
    }
  }

  drawTrees(ctx2d, camera, map, minTx, maxTx, minTy, maxTy);
}

function drawTrees(ctx2d, camera, map, minTx, maxTx, minTy, maxTy) {
  if (!map.trees || map.trees.length === 0) return;
  const size = camera.pixelsPerTile * 1.4;
  for (const tree of map.trees) {
    if (tree.x < minTx - 1 || tree.x > maxTx + 1 || tree.y < minTy - 1 || tree.y > maxTy + 1) continue;
    const variant = (tree.x * 7 + tree.y * 13) % 2;
    const sprite = getTreeSprite(size, variant);
    const p = camera.worldToScreen(tree.x + 0.5, tree.y + 0.5);
    ctx2d.drawImage(sprite, p.x - sprite.width / 2, p.y - sprite.height / 2);
  }
}
