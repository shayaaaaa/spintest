// Cogforge Concern — industrial mechanist faction. Original names/theme,
// no relation to any copyrighted faction.
export default {
  id: 'cogforge',
  name: 'Cogforge Concern',
  color: '#d99a3a',
  resourceFlavor: { materials: 'Scrap', lumber: 'Lumber' },
  startingUnitCount: 3,
  workerTypeId: 'wrenchHand',
  townHallId: 'foundry',

  units: {
    wrenchHand: {
      id: 'wrenchHand', name: 'Wrench Hand', role: 'worker',
      cost: { materials: 50 }, buildTime: 15, hp: 120, armor: 0, armorClass: 'light',
      speed: 2.6, sight: 5, cargoCapacity: 10, canBuild: true, canGather: true, supplyCost: 1,
    },
    stoker: {
      id: 'stoker', name: 'Stoker', role: 'infantry',
      cost: { materials: 80, lumber: 10 }, buildTime: 18, hp: 220, armor: 1, armorClass: 'normal',
      dmg: { min: 8, max: 12, type: 'normal' }, range: 1, cooldown: 1.1, speed: 2.2, sight: 6, supplyCost: 2,
    },
    clanktread: {
      id: 'clanktread', name: 'Clanktread', role: 'lightVehicle',
      cost: { materials: 140, lumber: 40 }, buildTime: 30, hp: 400, armor: 4, armorClass: 'fortified',
      dmg: { min: 14, max: 20, type: 'siege' }, range: 4, cooldown: 1.6, speed: 2.8, sight: 7, supplyCost: 2,
    },
    ironclad: {
      id: 'ironclad', name: 'Ironclad', role: 'heavyVehicle',
      cost: { materials: 210, lumber: 90 }, buildTime: 42, hp: 620, armor: 7, armorClass: 'fortified',
      dmg: { min: 22, max: 30, type: 'siege' }, range: 1, cooldown: 1.4, speed: 1.9, sight: 6, supplyCost: 2,
    },
  },

  buildings: {
    foundry: {
      id: 'foundry', name: 'Townhall', isTownHall: true, footprint: { w: 3, h: 3 },
      cost: { materials: 400 }, buildTime: 90, hp: 1200, armor: 5, armorClass: 'fortified', sight: 8,
      trains: ['wrenchHand'],
    },
    barracks: {
      id: 'barracks', name: 'Barracks', footprint: { w: 2, h: 2 },
      cost: { materials: 150, lumber: 20 }, buildTime: 30, hp: 650, armor: 2, armorClass: 'fortified', sight: 6,
      trains: ['stoker', 'clanktread', 'ironclad'],
    },
    heroAltar: {
      id: 'heroAltar', name: 'Hero Altar', footprint: { w: 2, h: 2 },
      cost: { materials: 150, lumber: 40 }, buildTime: 35, hp: 500, armor: 2, armorClass: 'fortified', sight: 6,
      trains: ['ironwright'],
    },
  },

  heroes: {
    ironwright: {
      id: 'ironwright', name: 'Ironwright', role: 'hero',
      cost: { materials: 260, lumber: 60 }, buildTime: 45,
      hp: 600, armor: 3, armorClass: 'normal', dmg: { min: 20, max: 28, type: 'normal' },
      range: 1, cooldown: 1.2, speed: 2.4, sight: 8, cargoCapacity: 0, supplyCost: 5,
      abilities: ['overclock', 'turretDrop', 'forgeRepair'],
    },
  },

  techtreeId: 'cogforgeTech',
};
