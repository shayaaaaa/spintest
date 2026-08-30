// Feeds each human player's FogOfWar from their units' and buildings'
// sight radii. Recomputed on a timer (not every tick) — see ctx.fogTimer.
const RECOMPUTE_INTERVAL = 0.3; // seconds (~3Hz)

export function updateVisibility(ctx, dt) {
  ctx.fogTimer = (ctx.fogTimer || 0) - dt;
  if (ctx.fogTimer > 0) return;
  ctx.fogTimer = RECOMPUTE_INTERVAL;

  for (const [ownerId, player] of Object.entries(ctx.players)) {
    const fog = ctx.fogByOwner[ownerId];
    if (!fog) continue;
    const sighters = [];
    for (const u of ctx.store.unitsOf(Number(ownerId))) {
      sighters.push({ tx: Math.floor(u.x), ty: Math.floor(u.y), sight: u.sight || 6 });
    }
    for (const b of ctx.store.buildingsOf(Number(ownerId))) {
      if (b.underConstruction) continue;
      sighters.push({ tx: Math.floor(b.x), ty: Math.floor(b.y), sight: b.sight || 6 });
    }
    fog.recompute(sighters);
  }
}
