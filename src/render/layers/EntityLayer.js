import { getUnitSprite, getBuildingSprite, getResourceNodeSprite } from '../sprites/ShapeSprites.js';
import { nodeSpriteBox } from '../../entities/ResourceNode.js';
import { Visibility } from '../../world/FogOfWar.js';
import { tileVisibility } from './FogLayer.js';

const NEUTRAL_COLOR = '#c9c9c9';
const CARGO_COLORS = { materials: '#d9b23a', lumber: '#8a5a2e' };

function visibilityFor(entity, gameCtx) {
  if (entity.ownerId === gameCtx.localPlayerId) return Visibility.VISIBLE;
  const fog = gameCtx.fogByOwner[gameCtx.localPlayerId];
  return tileVisibility(fog, entity.x, entity.y);
}

function inRect(entity, rect) {
  return entity.x >= rect.minX && entity.x <= rect.maxX && entity.y >= rect.minY && entity.y <= rect.maxY;
}

export function drawEntities(ctx2d, camera, gameCtx) {
  const rect = camera.visibleRect(2);
  const ppt = camera.pixelsPerTile;

  const nodes = [], buildings = [], units = [];
  for (const e of gameCtx.store.all) {
    if (!inRect(e, rect)) continue;
    if (e.kind === 'resourceNode') nodes.push(e);
    else if (e.kind === 'building') buildings.push(e);
    else if (e.kind === 'unit') units.push(e);
  }

  for (const node of nodes) drawResourceNode(ctx2d, camera, gameCtx, node, ppt);
  for (const b of buildings) drawBuilding(ctx2d, camera, gameCtx, b, ppt);
  for (const u of units) drawUnit(ctx2d, camera, gameCtx, u, ppt);
}

function alphaFor(entity, visibility) {
  let a = 1;
  if (visibility === Visibility.EXPLORED) a = 0.55;
  if (entity.dyingTimer !== undefined) a *= Math.max(0, entity.dyingTimer / 0.6);
  if (entity.underConstruction) a *= 0.85;
  return a;
}

function drawResourceNode(ctx2d, camera, gameCtx, node, ppt) {
  // Lumber nodes sit on top of an actual tree, already drawn by
  // TerrainLayer.js at the same spot — no separate circle/label needed.
  if (node.resourceType === 'lumber') return;
  const vis = visibilityFor(node, gameCtx);
  if (vis === Visibility.HIDDEN) return;
  const diameter = ppt * nodeSpriteBox(node); // sized from the node's own radius
  const sprite = getResourceNodeSprite(node.resourceType, diameter);
  const p = camera.worldToScreen(node.x, node.y);
  ctx2d.globalAlpha = alphaFor(node, vis);
  ctx2d.drawImage(sprite, p.x - sprite.width / 2, p.y - sprite.height / 2);
  drawLabel(ctx2d, node.name, p.x, p.y, diameter);
  ctx2d.globalAlpha = 1;
}

function drawBuilding(ctx2d, camera, gameCtx, b, ppt) {
  const vis = visibilityFor(b, gameCtx);
  if (vis === Visibility.HIDDEN) return;
  const color = gameCtx.players[b.ownerId]?.race.color || NEUTRAL_COLOR;
  const wPx = b.footprint.w * ppt, hPx = b.footprint.h * ppt;
  const sprite = getBuildingSprite(b.isTownHall, color, wPx, hPx);
  const topLeft = camera.worldToScreen(b.x - b.footprint.w / 2, b.y - b.footprint.h / 2);
  const center = camera.worldToScreen(b.x, b.y);
  ctx2d.globalAlpha = alphaFor(b, vis);
  ctx2d.drawImage(sprite, topLeft.x, topLeft.y);
  drawLabel(ctx2d, b.name, center.x, center.y, Math.min(wPx, hPx));
  ctx2d.globalAlpha = 1;
}

// Draws an entity's name centered on it, sized to fit its footprint/diameter.
function drawLabel(ctx2d, text, cx, cy, boxSize) {
  if (!text) return;
  const fontSize = Math.max(8, Math.min(13, boxSize * 0.22));
  ctx2d.font = `600 ${fontSize}px -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif`;
  ctx2d.textAlign = 'center';
  ctx2d.textBaseline = 'middle';
  ctx2d.lineWidth = Math.max(2, fontSize * 0.28);
  ctx2d.strokeStyle = 'rgba(0,0,0,0.75)';
  ctx2d.strokeText(text, cx, cy);
  ctx2d.fillStyle = '#ffffff';
  ctx2d.fillText(text, cx, cy);
}

function drawUnit(ctx2d, camera, gameCtx, u, ppt) {
  const vis = visibilityFor(u, gameCtx);
  if (vis !== Visibility.VISIBLE) return;
  const color = gameCtx.players[u.ownerId]?.race.color || NEUTRAL_COLOR;
  const size = ppt * (u.isHero ? 0.85 : u.role === 'worker' ? 0.75 : 0.7);
  const sprite = getUnitSprite(u.role, color, size);
  const p = camera.worldToScreen(u.x, u.y);
  ctx2d.globalAlpha = alphaFor(u, vis);
  ctx2d.drawImage(sprite, p.x - sprite.width / 2, p.y - sprite.height / 2);
  ctx2d.globalAlpha = 1;

  if (u.cargoAmount > 0) {
    const cx = p.x + size * 0.34, cy = p.y - size * 0.34, r = size * 0.2;
    ctx2d.fillStyle = CARGO_COLORS[u.cargoType] || CARGO_COLORS.materials;
    ctx2d.beginPath();
    ctx2d.arc(cx, cy, r, 0, Math.PI * 2);
    ctx2d.fill();
    ctx2d.strokeStyle = 'rgba(0,0,0,0.7)';
    ctx2d.lineWidth = Math.max(1, r * 0.25);
    ctx2d.stroke();
  }
}
