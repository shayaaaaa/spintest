import { EntityStore } from '../entities/EntityStore.js';
import { createUnit } from '../entities/Unit.js';
import { createBuilding } from '../entities/Building.js';
import { createResourceNode } from '../entities/ResourceNode.js';
import { GameMap } from '../world/Map.js';
import { FogOfWar } from '../world/FogOfWar.js';
import { PathRequestQueue } from '../world/Pathfinding.js';
import { SpatialGrid } from '../world/SpatialGrid.js';
import { EventBus } from '../core/EventBus.js';
import { Rng } from '../core/Rng.js';
import { Player } from './Player.js';
import { checkVictory } from './VictoryConditions.js';
import { AIController } from '../ai/AIController.js';

import { updateMovement } from '../systems/MovementSystem.js';
import { updateGathering } from '../systems/GatheringSystem.js';
import { updateProduction } from '../systems/ProductionSystem.js';
import { updateCombat } from '../systems/CombatSystem.js';
import { updateAbilities } from '../systems/AbilitySystem.js';
import { updateVisibility } from '../systems/VisibilitySystem.js';
import { updateLifecycle } from '../systems/LifecycleSystem.js';

import cogforge from '../data/races/cogforge.js';
import thornback from '../data/races/thornback.js';
import vharn from '../data/races/vharn.js';
import { abilities } from '../data/abilities.js';
import { techtreesById } from '../data/techtree.js';
import { levelsById } from '../levels/skirmish_1v1.js';

export const racesById = { cogforge, thornback, vharn };
const LUMBER_PER_TREE = 150;

export class Game {
  constructor({ levelId = 'skirmish_1v1', localPlayerId = 0, participants }) {
    this.levelId = levelId;
    this.localPlayerId = localPlayerId;
    this.eventBus = new EventBus();
    this.rng = new Rng(0xC0FFEE ^ Date.now());
    this.time = 0;
    this.gameOver = null;

    const level = levelsById[levelId];
    this.map = new GameMap(level);

    this.store = new EntityStore();
    this.pathQueue = new PathRequestQueue(this.map.grid, 8);
    this.spatialGrid = new SpatialGrid();

    this.players = {};
    this.fogByOwner = {};
    this.aiControllers = [];

    this.racesById = racesById;
    this.abilities = abilities;
    this.techtreesById = techtreesById;

    this._setupPlayers(participants, level);
    this.spatialGrid.rebuild(this.store.all);
  }

  // ctx passed to every system — Game itself is the single source of truth.
  get ctx() { return this; }

  _setupPlayers(participants, level) {
    participants.forEach((p, idx) => {
      const race = racesById[p.raceId];
      const player = new Player(p.ownerId, race, !!p.isAI);
      this.players[p.ownerId] = player;
      this.fogByOwner[p.ownerId] = new FogOfWar(this.map.width, this.map.height);
      if (p.isAI) this.aiControllers.push(new AIController(p.ownerId, p.difficulty));

      const spawn = level.spawnPoints[idx % level.spawnPoints.length];
      this._spawnStartingBase(player, race, spawn);
    });

    for (const spec of level.resourceNodes) {
      createResourceNode(this.store, spec);
    }

    // Every tree is also a harvestable lumber node, positioned at the tile
    // center to match where the tree sprite is actually drawn — the
    // visual is TerrainLayer.js's tree, this is just the gather mechanic.
    for (const tree of level.trees || []) {
      createResourceNode(this.store, {
        resourceType: 'lumber', amount: LUMBER_PER_TREE,
        x: tree.x + 0.5, y: tree.y + 0.5, maxHarvesters: 1,
      });
    }
  }

  _spawnStartingBase(player, race, spawn) {
    const townHallDef = race.buildings[race.townHallId];
    const th = createBuilding(this.store, {
      ownerId: player.id, def: townHallDef, x: spawn.x, y: spawn.y, underConstruction: false,
    });
    this.map.grid.setRectBlocked(
      Math.round(spawn.x - townHallDef.footprint.w / 2), Math.round(spawn.y - townHallDef.footprint.h / 2),
      townHallDef.footprint.w, townHallDef.footprint.h, true,
    );

    const workerDef = race.units[race.workerTypeId];
    for (let i = 0; i < race.startingUnitCount; i++) {
      const angle = (i / race.startingUnitCount) * Math.PI * 2;
      const wx = spawn.x + Math.cos(angle) * 3;
      const wy = spawn.y + Math.sin(angle) * 3;
      createUnit(this.store, { ownerId: player.id, def: workerDef, x: wx, y: wy });
    }
    return th;
  }

  // Rebuilds live entities from a GameState.serialize() snapshot. Used by
  // the "resume" flow — see src/ui/MenuScreens.js.
  applySnapshot(snapshot) {
    const level = levelsById[snapshot.levelId] || levelsById[this.levelId];
    this.map = new GameMap(level);
    this.store = new EntityStore();
    this.pathQueue = new PathRequestQueue(this.map.grid, 8);
    this.time = snapshot.time || 0;
    this.gameOver = null;
    this.players = {};
    this.fogByOwner = {};
    this.aiControllers = [];

    for (const p of snapshot.players) {
      const race = racesById[p.raceId];
      const player = new Player(p.id, race, p.isAI);
      player.resources = { ...p.resources };
      player.researchedTech = new Set(p.researchedTech);
      this.players[p.id] = player;
      this.fogByOwner[p.id] = new FogOfWar(this.map.width, this.map.height);
      if (p.isAI) this.aiControllers.push(new AIController(p.id));
    }

    for (const b of snapshot.buildings) {
      const race = racesById[this.players[b.ownerId].raceId];
      const def = race.buildings[b.typeId];
      const building = createBuilding(this.store, {
        ownerId: b.ownerId, def, x: b.x, y: b.y, underConstruction: b.underConstruction,
      });
      building.hp = b.hp;
      building.constructionProgress = b.constructionProgress;
      building.queue = b.queue;
      this.map.grid.setRectBlocked(
        Math.round(b.x - def.footprint.w / 2), Math.round(b.y - def.footprint.h / 2),
        def.footprint.w, def.footprint.h, true,
      );
    }

    for (const u of snapshot.units) {
      const race = racesById[this.players[u.ownerId].raceId];
      const def = u.isHero ? race.heroes[u.typeId] : race.units[u.typeId];
      const unit = createUnit(this.store, { ownerId: u.ownerId, def, x: u.x, y: u.y, isHero: u.isHero });
      Object.assign(unit, {
        hp: u.hp, level: u.level, xp: u.xp, xpToNext: u.xpToNext, abilityPoints: u.abilityPoints,
        cargoType: u.cargoType, cargoAmount: u.cargoAmount, stance: u.stance,
      });
      if (u.abilities) for (const a of u.abilities) {
        const entry = unit.abilities.find((e) => e.id === a.id);
        if (entry) entry.level = a.level;
      }
    }

    for (const n of snapshot.resourceNodes) createResourceNode(this.store, n);

    this.spatialGrid.rebuild(this.store.all);
  }

  tick(dt) {
    this.time += dt;
    updateMovement(this, dt);
    updateGathering(this, dt);
    updateProduction(this, dt);
    updateCombat(this, dt);
    updateAbilities(this, dt);
    updateVisibility(this, dt);
    updateLifecycle(this, dt);

    for (const ai of this.aiControllers) ai.update(this, dt);

    this.spatialGrid.rebuild(this.store.all);

    if (!this.gameOver) {
      const result = checkVictory(this);
      if (result) {
        this.gameOver = result;
        this.eventBus.emit('gameOver', result);
      }
    }
  }
}
