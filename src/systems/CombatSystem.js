import { moveUnitTo, stopUnit } from './MovementSystem.js';

// Small, original damage-type vs armor-class multiplier table (a genre
// mechanic, not protected content) — encourages composing different unit
// roles rather than mass-producing one type.
const ARMOR_FACTOR = {
  normal:   { normal: 1.0, fortified: 0.7, light: 1.15 },
  piercing: { normal: 1.15, fortified: 0.5, light: 1.5 },
  siege:    { normal: 0.85, fortified: 1.5, light: 0.6 },
};

const AGGRO_RADIUS = { aggressive: null, defensive: 4, passive: 0, holdPosition: null };

export function updateCombat(ctx, dt) {
  for (const unit of ctx.store.all) {
    if (unit.kind !== 'unit' || unit.hp <= 0) continue;
    if (unit.dmgMax <= 0) continue; // non-combat unit (pure worker)
    if (unit.stunnedUntil && unit.stunnedUntil > ctx.time) continue;
    if (unit.attackTimer > 0) unit.attackTimer -= dt;

    if (unit.state === 'gathering' || unit.state === 'movingToDropoff' || unit.state === 'casting') continue;

    let target = unit.targetId ? ctx.store.get(unit.targetId) : null;
    if (target && (target.hp <= 0 || target.ownerId === unit.ownerId)) target = null;

    if (!target) {
      target = acquireTarget(ctx, unit);
      unit.targetId = target ? target.id : null;
    }
    if (!target) continue;

    const dist = Math.hypot(target.x - unit.x, target.y - unit.y);
    if (dist > unit.range) {
      if (unit.stance === 'holdPosition') { unit.targetId = null; continue; }
      if (unit.state !== 'moving' || !unit.moveTarget || unit.moveTarget.id !== target.id) {
        moveUnitTo(ctx, unit, target.x, target.y);
        unit.moveTarget.id = target.id;
        unit.state = 'attacking'; // flag intent; movement still drives position
      }
      continue;
    }

    // In range: stop moving, face target, attack on cooldown.
    if (unit.state === 'moving') stopUnit(unit);
    unit.state = 'attacking';
    unit.facing = Math.atan2(target.y - unit.y, target.x - unit.x);
    if (unit.attackTimer <= 0) {
      dealDamage(ctx, unit, target);
      unit.attackTimer = unit.cooldown * (unit.attackSpeedMultiplier || 1);
    }
  }
}

function acquireTarget(ctx, unit) {
  if (unit.stance === 'passive') return null;
  const radius = AGGRO_RADIUS[unit.stance] ?? unit.sight;
  const searchRadius = radius == null ? unit.sight : radius;
  let best = null, bestDist = Infinity;
  for (const other of ctx.spatialGrid.queryRadius(unit.x, unit.y, searchRadius)) {
    if (other.hp === undefined || other.hp <= 0) continue;
    if (other.ownerId === unit.ownerId || other.ownerId === undefined) continue;
    if (!ctx.players[unit.ownerId] || !ctx.players[other.ownerId]) continue;
    if (ctx.players[unit.ownerId].isAllyOf?.(other.ownerId)) continue;
    const d = Math.hypot(other.x - unit.x, other.y - unit.y);
    if (d <= searchRadius && d < bestDist) { bestDist = d; best = other; }
  }
  return best;
}

function dealDamage(ctx, attacker, target) {
  const roll = ctx.rng.range(attacker.dmgMin, attacker.dmgMax);
  const factor = ARMOR_FACTOR[attacker.dmgType]?.[target.armorClass] ?? 1;
  const raw = roll * factor - (target.armor || 0);
  const dmg = Math.max(1, Math.round(raw));
  target.hp = Math.max(0, target.hp - dmg);
  ctx.eventBus.emit('unitDamaged', { attacker, target, dmg });
  if (target.hp <= 0) {
    ctx.eventBus.emit('unitDied', { unit: target, killer: attacker });
    grantHeroXp(ctx, attacker, target);
  }
}

function grantHeroXp(ctx, attacker, slain) {
  const xpValue = (slain.maxHp || 100) * 0.5 + (slain.isHero ? 150 : 0);
  for (const u of ctx.store.unitsOf(attacker.ownerId)) {
    if (!u.isHero || u.hp <= 0) continue;
    const d = Math.hypot(u.x - slain.x, u.y - slain.y);
    if (d > 12) continue;
    u.xp += xpValue;
    while (u.xp >= u.xpToNext) {
      u.xp -= u.xpToNext;
      u.level += 1;
      u.abilityPoints += 1;
      u.maxHp += 40;
      u.hp += 40;
      u.xpToNext = Math.round(u.xpToNext * 1.35);
      ctx.eventBus.emit('heroLeveledUp', { unit: u });
    }
  }
}

export function setStance(unit, stance) {
  unit.stance = stance;
  if (stance === 'passive') unit.targetId = null;
}
