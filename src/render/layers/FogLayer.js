import { Visibility } from '../../world/FogOfWar.js';

export function drawFog(ctx2d, camera, fog) {
  if (!fog) return;
  const rect = camera.visibleRect(1);
  const minTx = Math.max(0, Math.floor(rect.minX));
  const maxTx = Math.min(fog.width - 1, Math.ceil(rect.maxX));
  const minTy = Math.max(0, Math.floor(rect.minY));
  const maxTy = Math.min(fog.height - 1, Math.ceil(rect.maxY));
  const ppt = camera.pixelsPerTile;

  for (let ty = minTy; ty <= maxTy; ty++) {
    for (let tx = minTx; tx <= maxTx; tx++) {
      const v = fog.at(tx, ty);
      if (v === Visibility.VISIBLE) continue;
      ctx2d.fillStyle = v === Visibility.HIDDEN ? 'rgba(3,5,8,0.96)' : 'rgba(3,5,8,0.55)';
      const p = camera.worldToScreen(tx, ty);
      ctx2d.fillRect(Math.floor(p.x), Math.floor(p.y), Math.ceil(ppt) + 1, Math.ceil(ppt) + 1);
    }
  }
}

export function tileVisibility(fog, wx, wy) {
  if (!fog) return Visibility.VISIBLE;
  return fog.at(Math.floor(wx), Math.floor(wy));
}
