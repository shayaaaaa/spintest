import { Visibility } from '../../world/FogOfWar.js';
import { tileVisibility } from './FogLayer.js';

export function drawSelection(ctx2d, camera, gameCtx, selection) {
  const ppt = camera.pixelsPerTile;
  const fog = gameCtx.fogByOwner[gameCtx.localPlayerId];

  for (const e of gameCtx.store.all) {
    if (e.hp === undefined) continue;
    const isSelected = selection.has(e.id);
    const isOwn = e.ownerId === gameCtx.localPlayerId;
    const vis = isOwn ? Visibility.VISIBLE : tileVisibility(fog, e.x, e.y);
    if (e.kind === 'unit' && vis !== Visibility.VISIBLE) continue;
    if (e.kind !== 'unit' && vis === Visibility.HIDDEN) continue;
    const damaged = e.hp < e.maxHp;
    if (!isSelected && !damaged) continue;

    const w = e.kind === 'building' ? e.footprint.w * ppt : ppt * 0.8;
    const p = camera.worldToScreen(e.x, e.kind === 'building' ? e.y - e.footprint.h / 2 : e.y);
    const yOffset = e.kind === 'building' ? -6 : -ppt * 0.55;

    if (isSelected) {
      ctx2d.strokeStyle = isOwn ? '#7fe08a' : '#e0666f';
      ctx2d.lineWidth = 2;
      ctx2d.beginPath();
      const rw = e.kind === 'building' ? w : ppt * 0.7;
      ctx2d.ellipse(camera.worldToScreen(e.x, e.y).x, camera.worldToScreen(e.x, e.y).y, rw / 2, rw / 4, 0, 0, Math.PI * 2);
      ctx2d.stroke();
    }

    // Health bar
    const barW = w * 0.9;
    const barX = p.x - barW / 2;
    const barY = p.y + yOffset;
    ctx2d.fillStyle = 'rgba(0,0,0,0.6)';
    ctx2d.fillRect(barX, barY, barW, 5);
    const pct = Math.max(0, e.hp / e.maxHp);
    ctx2d.fillStyle = pct > 0.5 ? '#5fd35f' : pct > 0.25 ? '#e0c23a' : '#e05a5a';
    ctx2d.fillRect(barX, barY, barW * pct, 5);
  }
}

// Rubber-band drag box, drawn directly in screen space.
export function drawDragBox(ctx2d, box) {
  if (!box) return;
  const x = Math.min(box.startX, box.curX);
  const y = Math.min(box.startY, box.curY);
  const w = Math.abs(box.curX - box.startX);
  const h = Math.abs(box.curY - box.startY);
  ctx2d.fillStyle = 'rgba(120,200,255,0.15)';
  ctx2d.fillRect(x, y, w, h);
  ctx2d.strokeStyle = 'rgba(120,200,255,0.9)';
  ctx2d.lineWidth = 1.5;
  ctx2d.strokeRect(x, y, w, h);
}
