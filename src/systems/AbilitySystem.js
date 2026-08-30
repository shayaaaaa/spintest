// Hero ability learning, casting, and resolution. Abilities are looked up
// by id in the shared src/data/abilities.js registry — this file only
// knows how to execute the small set of effect kinds that registry uses.

export function learnAbility(ctx, hero, abilityId) {
  const entry = hero.abilities.find((a) => a.id === abilityId);
  const def = ctx.abilities[abilityId];
  if (!entry || !def) return { ok: false, reason: 'unknown' };
  if (hero.abilityPoints <= 0) return { ok: false, reason: 'noPoints' };
  if (entry.level >= def.maxLevel) return { ok: false, reason: 'maxed' };
  entry.level += 1;
  hero.abilityPoints -= 1;
  ctx.eventBus.emit('abilityLearned', { hero, abilityId });
  return { ok: true };
}

// targetSpec: null (self), {x,y} (point), or a unit entity (unit target)
export function castAbility(ctx, hero, abilityId, targetSpec) {
  const entry = hero.abilities.find((a) => a.id === abilityId);
  const def = ctx.abilities[abilityId];
  if (!entry || !def || entry.level <= 0) return { ok: false, reason: 'notLearned' };
  if (entry.cooldownLeft > 0) return { ok: false, reason: 'cooldown' };
  const player = ctx.players[hero.ownerId];
  if (!Object.entries(def.cost || {}).every(([res, amt]) => (player.resources[res] || 0) >= amt)) {
    return { ok: false, reason: 'cost' };
  }
  for (const [res, amt] of Object.entries(def.cost || {})) player.resources[res] -= amt;

  EFFECTS[def.effect]?.(ctx, hero, def, entry.level, targetSpec);
  entry.cooldownLeft = def.cooldown;
  ctx.eventBus.emit('resourcesChanged', { ownerId: hero.ownerId });
  ctx.eventBus.emit('abilityCast', { hero, abilityId, targetSpec });
  return { ok: true };
}

const EFFECTS = {
  buffAttackSpeed(ctx, hero, def, level, targetSpec) {
    const unit = targetSpec?.id ? ctx.store.get(targetSpec.id) : hero;
    if (!unit) return;
    const magnitude = (def.params.magnitudePerLevel || 0.1) * level;
    unit.attackSpeedMultiplier = Math.max(0.3, 1 - magnitude);
    unit.attackSpeedExpiresAt = ctx.time + (def.params.duration || 6);
  },
  summonTurret(ctx, hero, def, level, targetSpec) {
    const x = targetSpec?.x ?? hero.x;
    const y = targetSpec?.y ?? hero.y;
    const hp = (def.params.hpPerLevel || 100) * level;
    const turret = ctx.store.add({
      kind: 'unit', typeId: 'summonedTurret', name: 'Turret', role: 'summon',
      x, y, renderX: x, renderY: y, facing: 0,
      ownerId: hero.ownerId, hp, maxHp: hp, armor: 2, armorClass: 'fortified',
      dmgMin: 8, dmgMax: 14, dmgType: 'piercing', range: 5, cooldown: 1, sight: 6,
      attackTimer: 0, targetId: null, stance: 'aggressive',
      cargoType: null, cargoAmount: 0, cargoCapacity: 0,
      speed: 0, canBuild: false, canGather: false, supplyCost: 0,
      state: 'idle', path: null, pathIndex: 0, moveTarget: null, order: null,
      level: 0, xp: 0, xpToNext: Infinity, abilityPoints: 0, abilities: [],
      isSummon: true, expiresAt: ctx.time + (def.params.duration || 20),
    });
    ctx.eventBus.emit('unitSpawned', { unit: turret });
  },
  heal(ctx, hero, def, level, targetSpec) {
    const unit = targetSpec?.id ? ctx.store.get(targetSpec.id) : hero;
    if (!unit) return;
    const amount = (def.params.amountPerLevel || 40) * level;
    unit.hp = Math.min(unit.maxHp, unit.hp + amount);
  },
  damageArea(ctx, hero, def, level, targetSpec) {
    const x = targetSpec?.x ?? hero.x, y = targetSpec?.y ?? hero.y;
    const radius = def.params.radius || 2.5;
    const dmg = (def.params.dmgPerLevel || 30) * level;
    for (const other of ctx.spatialGrid.queryRadius(x, y, radius)) {
      if (other.hp === undefined || other.hp <= 0 || other.ownerId === hero.ownerId) continue;
      if (Math.hypot(other.x - x, other.y - y) > radius) continue;
      other.hp = Math.max(0, other.hp - dmg);
      if (other.hp <= 0) ctx.eventBus.emit('unitDied', { unit: other, killer: hero });
    }
  },
  stun(ctx, hero, def, level, targetSpec) {
    const unit = targetSpec?.id ? ctx.store.get(targetSpec.id) : null;
    if (!unit) return;
    unit.stunnedUntil = ctx.time + (def.params.durationPerLevel || 1) * level;
  },
};

export function updateAbilities(ctx, dt) {
  for (const unit of ctx.store.all) {
    if (unit.kind !== 'unit') continue;
    if (unit.isHero) {
      for (const entry of unit.abilities) if (entry.cooldownLeft > 0) entry.cooldownLeft -= dt;
    }
    if (unit.attackSpeedExpiresAt && ctx.time >= unit.attackSpeedExpiresAt) {
      unit.attackSpeedMultiplier = 1;
      unit.attackSpeedExpiresAt = null;
    }
    if (unit.isSummon && unit.expiresAt && ctx.time >= unit.expiresAt) {
      ctx.store.remove(unit);
    }
  }
}
