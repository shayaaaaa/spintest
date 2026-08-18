// Per-race tech DAGs, referenced by races/*.js `techtreeId`. Each node:
// { id, cost, researchTime, requires:[ids], unlocks:[buildingOrUnitIds], researchedAt: buildingTypeId }
// `unlocks` is informational for UI; the actual gate is buildings/units
// declaring `requiresTech` and ProductionSystem/BuildPlacementController
// checking `player.researchedTech`.

export const cogforgeTech = {
  basicMachining: {
    id: 'basicMachining', name: 'Basic Machining', cost: { materials: 100, energy: 30 }, researchTime: 40,
    requires: [], unlocks: ['gantryWorks'], researchedAt: 'assemblyYard',
  },
  advancedPlating: {
    id: 'advancedPlating', name: 'Advanced Plating', cost: { materials: 200, energy: 80 }, researchTime: 60,
    requires: ['basicMachining'], unlocks: ['ironclad'], researchedAt: 'gantryWorks',
  },
};

export const thornbackTech = {
  packTactics: {
    id: 'packTactics', name: 'Pack Tactics', cost: { materials: 100, energy: 25 }, researchTime: 38,
    requires: [], unlocks: ['warcamp'], researchedAt: 'beastPen',
  },
  ironHide: {
    id: 'ironHide', name: 'Iron Hide', cost: { materials: 190, energy: 70 }, researchTime: 55,
    requires: ['packTactics'], unlocks: ['direwolf'], researchedAt: 'warcamp',
  },
};

export const vharnTech = {
  mutationSurge: {
    id: 'mutationSurge', name: 'Mutation Surge', cost: { materials: 110, energy: 25 }, researchTime: 36,
    requires: [], unlocks: ['carapaceWarren'], researchedAt: 'broodChamber',
  },
  biomass: {
    id: 'biomass', name: 'Biomass Overgrowth', cost: { materials: 210, energy: 85 }, researchTime: 58,
    requires: ['mutationSurge'], unlocks: ['carapaceTitan'], researchedAt: 'carapaceWarren',
  },
};

export const techtreesById = {
  cogforgeTech, thornbackTech, vharnTech,
};
