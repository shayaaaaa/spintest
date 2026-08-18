// Thornback Clans — nomadic beast-tamer tribes. Original names/theme, no
// relation to any copyrighted faction.
export default {
  id: 'thornback',
  name: 'Thornback Clans',
  color: '#5f9e4f',
  resourceFlavor: { materials: 'Hide & Timber', lumber: 'Lumber' },
  startingUnitCount: 3,
  workerTypeId: 'snarehand',
  townHallId: 'campfireHearth',

  units: {
    snarehand: {
      id: 'snarehand', name: 'Snarehand', role: 'worker',
      cost: { materials: 50 }, buildTime: 14, hp: 110, armor: 0, armorClass: 'light',
      speed: 2.8, sight: 5, cargoCapacity: 10, canBuild: true, canGather: true, supplyCost: 1,
    },
    ridgeLasher: {
      id: 'ridgeLasher', name: 'Ridge Lasher', role: 'raider',
      cost: { materials: 75, lumber: 5 }, buildTime: 16, hp: 160, armor: 0, armorClass: 'light',
      dmg: { min: 9, max: 13, type: 'normal' }, range: 1, cooldown: 0.9, speed: 3.2, sight: 6, supplyCost: 2,
    },
    warYak: {
      id: 'warYak', name: 'War Yak', role: 'heavyBeast',
      cost: { materials: 150, lumber: 30 }, buildTime: 32, hp: 480, armor: 3, armorClass: 'fortified',
      dmg: { min: 16, max: 22, type: 'normal' }, range: 1, cooldown: 1.5, speed: 2.0, sight: 6, supplyCost: 2,
    },
    direwolf: {
      id: 'direwolf', name: 'Direwolf Rider', role: 'fastStriker',
      cost: { materials: 130, lumber: 50 }, buildTime: 26, hp: 260, armor: 1, armorClass: 'normal',
      dmg: { min: 14, max: 19, type: 'piercing' }, range: 1, cooldown: 1.0, speed: 3.6, sight: 7, supplyCost: 2,
    },
  },

  buildings: {
    campfireHearth: {
      id: 'campfireHearth', name: 'Townhall', isTownHall: true, footprint: { w: 3, h: 3 },
      cost: { materials: 400 }, buildTime: 90, hp: 1150, armor: 4, armorClass: 'fortified', sight: 8,
      trains: ['snarehand'],
    },
    barracks: {
      id: 'barracks', name: 'Barracks', footprint: { w: 2, h: 2 },
      cost: { materials: 150, lumber: 20 }, buildTime: 30, hp: 650, armor: 2, armorClass: 'fortified', sight: 6,
      trains: ['ridgeLasher', 'warYak', 'direwolf'],
    },
    heroAltar: {
      id: 'heroAltar', name: 'Hero Altar', footprint: { w: 2, h: 2 },
      cost: { materials: 150, lumber: 40 }, buildTime: 35, hp: 500, armor: 2, armorClass: 'fortified', sight: 6,
      trains: ['beastcaller'],
    },
  },

  heroes: {
    beastcaller: {
      id: 'beastcaller', name: 'Beastcaller', role: 'hero',
      cost: { materials: 260, lumber: 60 }, buildTime: 45,
      hp: 580, armor: 2, armorClass: 'normal', dmg: { min: 19, max: 27, type: 'normal' },
      range: 1, cooldown: 1.1, speed: 2.7, sight: 8, cargoCapacity: 0, supplyCost: 5,
      abilities: ['rendingPounce', 'primalHowl', 'mendFlesh'],
    },
  },

  techtreeId: 'thornbackTech',
};
