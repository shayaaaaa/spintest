// Shared ability registry, keyed by id. Race hero defs (src/data/races/*)
// reference these ids in their `abilities` list; engine code in
// AbilitySystem.js only knows `effect` names, never a specific ability.
export const abilities = {
  // --- Cogforge: Ironwright ---
  overclock: {
    id: 'overclock', name: 'Overclock', targeting: 'unit', cooldown: 14, cost: { lumber: 25 },
    effect: 'buffAttackSpeed', params: { duration: 8, magnitudePerLevel: 0.12 }, maxLevel: 3,
    description: 'Boosts a friendly unit’s attack speed for a short time.',
  },
  turretDrop: {
    id: 'turretDrop', name: 'Turret Drop', targeting: 'point', cooldown: 22, cost: { lumber: 45 },
    effect: 'summonTurret', params: { hpPerLevel: 110, duration: 25 }, maxLevel: 3,
    description: 'Deploys a temporary autonomous turret at the target point.',
  },
  forgeRepair: {
    id: 'forgeRepair', name: 'Forge Repair', targeting: 'unit', cooldown: 10, cost: { lumber: 20 },
    effect: 'heal', params: { amountPerLevel: 60 }, maxLevel: 3,
    description: 'Repairs/heals a friendly unit.',
  },

  // --- Thornback: Beastcaller ---
  rendingPounce: {
    id: 'rendingPounce', name: 'Rending Pounce', targeting: 'point', cooldown: 12, cost: { lumber: 30 },
    effect: 'damageArea', params: { radius: 2.2, dmgPerLevel: 28 }, maxLevel: 3,
    description: 'A tamed beast lunges at the target area, clawing all enemies nearby.',
  },
  primalHowl: {
    id: 'primalHowl', name: 'Primal Howl', targeting: 'unit', cooldown: 14, cost: { lumber: 25 },
    effect: 'buffAttackSpeed', params: { duration: 8, magnitudePerLevel: 0.12 }, maxLevel: 3,
    description: 'Rallies a unit into a faster-striking frenzy.',
  },
  mendFlesh: {
    id: 'mendFlesh', name: 'Mend Flesh', targeting: 'unit', cooldown: 10, cost: { lumber: 20 },
    effect: 'heal', params: { amountPerLevel: 65 }, maxLevel: 3,
    description: 'Channels nature’s vigor to heal a friendly unit.',
  },

  // --- Vharn: Genestitcher ---
  causticSpray: {
    id: 'causticSpray', name: 'Caustic Spray', targeting: 'point', cooldown: 12, cost: { lumber: 30 },
    effect: 'damageArea', params: { radius: 2.4, dmgPerLevel: 26 }, maxLevel: 3,
    description: 'Sprays corrosive bile over an area, damaging all enemies caught in it.',
  },
  neuralLock: {
    id: 'neuralLock', name: 'Neural Lock', targeting: 'unit', cooldown: 16, cost: { lumber: 35 },
    effect: 'stun', params: { durationPerLevel: 1.2 }, maxLevel: 3,
    description: 'Overloads an enemy’s nervous system, freezing it in place.',
  },
  chitinFrenzy: {
    id: 'chitinFrenzy', name: 'Chitin Frenzy', targeting: 'unit', cooldown: 14, cost: { lumber: 25 },
    effect: 'buffAttackSpeed', params: { duration: 8, magnitudePerLevel: 0.12 }, maxLevel: 3,
    description: 'Induces a mutation-fueled frenzy, quickening a unit’s attacks.',
  },
};
