// Lightweight transient visual effects (hit flashes) — no particle system,
// just a short-lived list drawn each frame and pruned when expired.
export function createEffectsState() {
  return { list: [] };
}

export function addHitFlash(effectsState, x, y) {
  effectsState.list.push({ type: 'hitFlash', x, y, born: performance.now() });
}

export function updateEffects(effectsState) {
  const now = performance.now();
  effectsState.list = effectsState.list.filter((e) => now - e.born < 220);
}

export function drawEffects(ctx2d, camera, effectsState) {
  const now = performance.now();
  for (const e of effectsState.list) {
    const t = (now - e.born) / 220;
    const p = camera.worldToScreen(e.x, e.y);
    ctx2d.globalAlpha = Math.max(0, 1 - t);
    ctx2d.strokeStyle = '#ffe07a';
    ctx2d.lineWidth = 2;
    ctx2d.beginPath();
    ctx2d.arc(p.x, p.y, camera.pixelsPerTile * (0.25 + t * 0.3), 0, Math.PI * 2);
    ctx2d.stroke();
  }
  ctx2d.globalAlpha = 1;
}

// Build-placement ghost footprint: green/red tint by validity.
export function drawBuildGhost(ctx2d, camera, ghost) {
  if (!ghost) return;
  const ppt = camera.pixelsPerTile;
  const w = ghost.footprint.w * ppt, h = ghost.footprint.h * ppt;
  const p = camera.worldToScreen(ghost.x - ghost.footprint.w / 2, ghost.y - ghost.footprint.h / 2);
  ctx2d.fillStyle = ghost.valid ? 'rgba(90,210,110,0.35)' : 'rgba(220,80,80,0.35)';
  ctx2d.fillRect(p.x, p.y, w, h);
  ctx2d.strokeStyle = ghost.valid ? '#5ad26e' : '#dc5050';
  ctx2d.lineWidth = 2;
  ctx2d.strokeRect(p.x, p.y, w, h);
}

// Ability/point-target reticle (reused for hero point-target casts).
export function drawTargetReticle(ctx2d, camera, worldX, worldY) {
  const p = camera.worldToScreen(worldX, worldY);
  const r = camera.pixelsPerTile * 0.5;
  ctx2d.strokeStyle = '#ffd35a';
  ctx2d.lineWidth = 2;
  ctx2d.beginPath();
  ctx2d.arc(p.x, p.y, r, 0, Math.PI * 2);
  ctx2d.moveTo(p.x - r, p.y);
  ctx2d.lineTo(p.x + r, p.y);
  ctx2d.moveTo(p.x, p.y - r);
  ctx2d.lineTo(p.x, p.y + r);
  ctx2d.stroke();
}
