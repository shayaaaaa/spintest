import { moveUnitTo, stopUnit } from '../systems/MovementSystem.js';

const RETREAT_HP_RATIO = 0.3;

// Note: the AI targets the enemy's known town hall directly rather than
// scouting through its own fog of war — an intentional simplification
// (per the prototype's "AI doesn't need to be sophisticated" scope), not
// a claim that the AI plays under the same information limits as a human.
function enemyTownHall(ctx, ownerId) {
  for (const b of ctx.store.all) {
    if (b.kind === 'building' && b.isTownHall && b.ownerId !== ownerId) return b;
  }
  return null;
}

function armyUnits(ctx, ownerId) {
  return [...ctx.store.unitsOf(ownerId)].filter((u) => u.dmgMax > 0 && !u.isHero);
}

export function runArmyTactics(ctx, ownerId, aiState, difficulty) {
  const townHall = [...ctx.store.buildingsOf(ownerId)].find((b) => b.isTownHall);
  const army = armyUnits(ctx, ownerId);

  // Retreat badly wounded units engaged in combat.
  for (const u of army) {
    if (u.state === 'attacking' && u.hp / u.maxHp < RETREAT_HP_RATIO && townHall) {
      u.targetId = null;
      moveUnitTo(ctx, u, townHall.x, townHall.y + 2);
    }
  }
  const hero = [...ctx.store.unitsOf(ownerId)].find((u) => u.isHero);
  if (hero && hero.hp / hero.maxHp < RETREAT_HP_RATIO && townHall && hero.state !== 'moving') {
    hero.targetId = null;
    moveUnitTo(ctx, hero, townHall.x, townHall.y + 2);
  }

  if (aiState.attacking) {
    if (army.length < Math.max(2, aiState.lastAttackSize / 3)) aiState.attacking = false;
    return;
  }

  const idleArmy = army.filter((u) => u.state === 'idle');
  const threshold = Math.max(4, Math.round(8 * difficulty.armySizeScale));
  const timeSinceAttack = ctx.time - (aiState.lastAttackTime || 0);
  const shouldAttack = idleArmy.length >= threshold || (army.length >= 3 && timeSinceAttack > difficulty.aggressionInterval);
  if (!shouldAttack || army.length === 0) return;

  const target = enemyTownHall(ctx, ownerId);
  if (!target) return;

  for (const u of army) {
    u.targetId = null;
    moveUnitTo(ctx, u, target.x, target.y);
  }
  if (hero) moveUnitTo(ctx, hero, target.x, target.y);
  aiState.attacking = true;
  aiState.lastAttackTime = ctx.time;
  aiState.lastAttackSize = army.length;
}
