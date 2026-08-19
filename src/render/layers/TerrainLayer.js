import { Terrain } from '../../world/Map.js';
import { getTreeSprite } from '../sprites/ShapeSprites.js';
import { TREE_FALL_SECONDS } from '../../systems/ResourceNodeSystem.js';

const TERRAIN_COLORS = {
  [Terrain.GRASS]: '#3a6b35',
  [Terrain.DIRT]: '#7a5a3a',
  [Terrain.WATER]: '#2a5a86',
  [Terrain.CLIFF]: '#5a5a5a',
};

// Draws only the tiles within the camera's visible rect — cheap enough to
// redraw every frame at typical viewport sizes without an offscreen cache.
export function drawTerrain(ctx2d, camera, map, time = 0) {
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

  drawTrees(ctx2d, camera, map, minTx, maxTx, minTy, maxTy, time);
}

// A tree that has been worked out topples and rots away over
// TREE_FALL_SECONDS. It goes over during the first stretch and then lies there
// fading, rather than doing both at once — a tree that dissolved while still
// upright would read as a rendering glitch instead of a tree coming down.
const FALL_PORTION = 0.45;  // of the total time spent toppling
const FADE_START = 0.5;     // fading begins halfway through
const FALLEN_ANGLE = 1.45;  // radians: flat on the ground, near enough

function felledTransform(tree, time) {
  const elapsed = time - tree.felledAt;
  const t = Math.max(0, Math.min(1, elapsed / TREE_FALL_SECONDS));
  // Ease out, so it tips slowly at first and drops away at the end the way
  // something heavy pivoting on its base does.
  const fall = Math.min(1, t / FALL_PORTION);
  const angle = FALLEN_ANGLE * fall * fall;
  const alpha = t < FADE_START ? 1 : 1 - (t - FADE_START) / (1 - FADE_START);
  // Deterministic per tree, so a stand of them doesn't all drop the same way.
  const dir = ((tree.x * 3 + tree.y * 5) % 2) === 0 ? 1 : -1;
  return { angle: angle * dir, alpha: Math.max(0, alpha) };
}

function drawTrees(ctx2d, camera, map, minTx, maxTx, minTy, maxTy, time) {
  if (!map.trees || map.trees.length === 0) return;
  const size = camera.pixelsPerTile * 1.4;
  for (const tree of map.trees) {
    if (tree.x < minTx - 1 || tree.x > maxTx + 1 || tree.y < minTy - 1 || tree.y > maxTy + 1) continue;
    const variant = (tree.x * 7 + tree.y * 13) % 2;
    const sprite = getTreeSprite(size, variant);
    const p = camera.worldToScreen(tree.x + 0.5, tree.y + 0.5);

    if (tree.felledAt === undefined) {
      ctx2d.drawImage(sprite, p.x - sprite.width / 2, p.y - sprite.height / 2);
      continue;
    }

    // Pivot about the foot of the trunk rather than the sprite's middle, so it
    // swings over like a felled trunk instead of spinning on the spot.
    const { angle, alpha } = felledTransform(tree, time);
    const pivotY = p.y + size * 0.44;
    ctx2d.save();
    ctx2d.globalAlpha = alpha;
    ctx2d.translate(p.x, pivotY);
    ctx2d.rotate(angle);
    ctx2d.drawImage(sprite, -size / 2, -size * 0.94);
    ctx2d.restore();
    ctx2d.globalAlpha = 1;
  }
}
