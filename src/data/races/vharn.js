// Vharn Swarm — insectoid hive faction. Original names/theme, no relation
// to any copyrighted faction.
export default {
  id: 'vharn',
  name: 'Vharn Swarm',
  color: '#8a4fb3',
  resourceFlavor: { materials: 'Biomass', energy: 'Mutagen', lumber: 'Lumber' },
  startingUnitCount: 3,
  workerTypeId: 'larvaDrudge',
  townHallId: 'hiveCore',

  units: {
    larvaDrudge: {
      id: 'larvaDrudge', name: 'Larva Drudge', role: 'worker',
      cost: { materials: 40 }, buildTime: 12, hp: 90, armor: 0, armorClass: 'light',
      speed: 2.6, sight: 5, cargoCapacity: 10, canBuild: true, canGather: true, supplyCost: 1,
    },
    chitinSkirmisher: {
      id: 'chitinSkirmisher', name: 'Chitin Skirmisher', role: 'infantry',
      cost: { materials: 70, energy: 5 }, buildTime: 14, hp: 190, armor: 1, armorClass: 'normal',
      dmg: { min: 7, max: 11, type: 'normal' }, range: 1, cooldown: 0.9, speed: 2.6, sight: 6, supplyCost: 2,
    },
    spinemaw: {
      id: 'spinemaw', name: 'Spinemaw', role: 'ranged',
      cost: { materials: 90, energy: 20 }, buildTime: 20, hp: 150, armor: 0, armorClass: 'light',
      dmg: { min: 10, max: 14, type: 'piercing' }, range: 4, cooldown: 1.3, speed: 2.4, sight: 7, supplyCost: 2,
      requiresTech: 'mutationSurge',
    },
    carapaceTitan: {
      id: 'carapaceTitan', name: 'Carapace Titan', role: 'heavySiege',
      cost: { materials: 180, energy: 70 }, buildTime: 36, hp: 550, armor: 5, armorClass: 'fortified',
      dmg: { min: 20, max: 28, type: 'siege' }, range: 1, cooldown: 1.6, speed: 1.8, sight: 6, supplyCost: 5,
      requiresTech: 'biomass',
    },
  },

  buildings: {
    hiveCore: {
      id: 'hiveCore', name: 'Townhall', isTownHall: true, footprint: { w: 3, h: 3 },
      cost: { materials: 400 }, buildTime: 90, hp: 1100, armor: 3, armorClass: 'fortified', sight: 8,
      providesSupply: 10, trains: ['larvaDrudge'],
    },
    broodChamber: {
      id: 'broodChamber', name: 'Brood Chamber', footprint: { w: 2, h: 2 },
      cost: { materials: 115 }, buildTime: 32, hp: 560, armor: 1, armorClass: 'fortified', sight: 6,
      trains: ['chitinSkirmisher'], researches: ['mutationSurge'],
    },
    carapaceWarren: {
      id: 'carapaceWarren', name: 'Carapace Warren', footprint: { w: 2, h: 2 },
      cost: { materials: 175, energy: 58 }, buildTime: 44, hp: 660, armor: 3, armorClass: 'fortified', sight: 6,
      trains: ['spinemaw', 'carapaceTitan'], researches: ['biomass'], requiresTech: 'mutationSurge',
    },
    glandNest: {
      id: 'glandNest', name: 'Gland Nest', footprint: { w: 1, h: 1 },
      cost: { materials: 78 }, buildTime: 19, hp: 360, armor: 1, armorClass: 'fortified', sight: 5,
      providesSupply: 6,
    },
  },

  heroes: {
    genestitcher: {
      id: 'genestitcher', name: 'Genestitcher', role: 'hero',
      cost: { materials: 260, energy: 60 }, buildTime: 45,
      hp: 560, armor: 2, armorClass: 'normal', dmg: { min: 18, max: 26, type: 'piercing' },
      range: 2, cooldown: 1.2, speed: 2.5, sight: 8, cargoCapacity: 0, supplyCost: 5,
      abilities: ['causticSpray', 'neuralLock', 'chitinFrenzy'],
    },
  },

  techtreeId: 'vharnTech',
};
