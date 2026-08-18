// Handles death/destruction: a short fade-out grace period (for the death
// animation in EffectsLayer), then actual removal + index cleanup.
const DEATH_FADE_SECONDS = 0.6;

export function updateLifecycle(ctx, dt) {
  const toRemove = [];
  for (const entity of ctx.store.all) {
    if (entity.hp === undefined) continue;
    if (entity.hp > 0) continue;

    if (entity.dyingTimer === undefined) {
      entity.dyingTimer = DEATH_FADE_SECONDS;
      ctx.eventBus.emit('entityDying', { entity });
      cleanupReferences(ctx, entity);
    } else {
      entity.dyingTimer -= dt;
      if (entity.dyingTimer <= 0) toRemove.push(entity);
    }
  }
  for (const entity of toRemove) {
    ctx.store.remove(entity);
    if (entity.kind === 'building') {
      const topLeftX = Math.round(entity.x - entity.footprint.w / 2);
      const topLeftY = Math.round(entity.y - entity.footprint.h / 2);
      ctx.map.grid.setRectBlocked(topLeftX, topLeftY, entity.footprint.w, entity.footprint.h, false);
    }
    ctx.eventBus.emit('entityRemoved', { entity });
  }
}

function cleanupReferences(ctx, entity) {
  if (entity.kind === 'unit' && entity.gatherNodeId) {
    const node = ctx.store.get(entity.gatherNodeId);
    node?.harvesterIds.delete(entity.id);
  }
  // Clear anyone targeting the dead entity so combat re-acquires next tick.
  for (const u of ctx.store.all) {
    if (u.targetId === entity.id) u.targetId = null;
    if (u.moveTarget?.id === entity.id) u.moveTarget = null;
  }
}
