import { balance } from '../data/balance.js';

export class Player {
  constructor(id, race, isAI = false) {
    this.id = id;
    this.race = race;
    this.raceId = race.id;
    this.isAI = isAI;
    this.resources = { ...balance.startingResources };
    this.researchedTech = new Set();
    this.defeated = false;
  }

  isAllyOf(otherOwnerId) {
    return otherOwnerId === this.id; // no alliances in this prototype
  }
}
