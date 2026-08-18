// A player is defeated once they have no buildings left (can't produce
// anything more) — simple and matches most RTS skirmish conventions.
// Returns { winnerId } once only one player remains, else null.
export function checkVictory(ctx) {
  let winner = null;
  let remaining = 0;

  for (const [idStr, player] of Object.entries(ctx.players)) {
    const id = Number(idStr);
    const hasBuildings = ctx.store.buildingsOf(id).size > 0;
    if (!hasBuildings && !player.defeated) {
      player.defeated = true;
      ctx.eventBus.emit('playerDefeated', { ownerId: id });
    }
    if (!player.defeated) {
      remaining++;
      winner = id;
    }
  }

  if (remaining <= 1 && Object.keys(ctx.players).length > 1) {
    return { winnerId: winner };
  }
  return null;
}
