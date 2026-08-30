// Central entity storage: Map<id, entity> plus index Sets that double as
// the broad-phase for pathfinding, targeting, AI queries, and render
// culling. Not a full archetype ECS — at this prototype's scale (soft cap
// ~150-250 active units) plain objects + a few indices are simpler and
// fast enough.
let nextId = 1;

export class EntityStore {
  constructor() {
    this.byId = new Map();
    this.unitsByOwner = new Map();      // ownerId -> Set<entity>
    this.buildingsByOwner = new Map();  // ownerId -> Set<entity>
    this.resourceNodes = new Set();
    this.all = new Set();
  }

  _ownerSet(map, ownerId) {
    if (!map.has(ownerId)) map.set(ownerId, new Set());
    return map.get(ownerId);
  }

  add(entity) {
    entity.id = nextId++;
    this.byId.set(entity.id, entity);
    this.all.add(entity);
    if (entity.kind === 'unit') this._ownerSet(this.unitsByOwner, entity.ownerId).add(entity);
    else if (entity.kind === 'building') this._ownerSet(this.buildingsByOwner, entity.ownerId).add(entity);
    else if (entity.kind === 'resourceNode') this.resourceNodes.add(entity);
    return entity;
  }

  remove(entity) {
    this.byId.delete(entity.id);
    this.all.delete(entity);
    if (entity.kind === 'unit') this.unitsByOwner.get(entity.ownerId)?.delete(entity);
    else if (entity.kind === 'building') this.buildingsByOwner.get(entity.ownerId)?.delete(entity);
    else if (entity.kind === 'resourceNode') this.resourceNodes.delete(entity);
  }

  get(id) {
    return this.byId.get(id);
  }

  unitsOf(ownerId) {
    return this.unitsByOwner.get(ownerId) ?? new Set();
  }

  buildingsOf(ownerId) {
    return this.buildingsByOwner.get(ownerId) ?? new Set();
  }

  *allUnitsAndBuildingsOf(ownerId) {
    yield* this.unitsOf(ownerId);
    yield* this.buildingsOf(ownerId);
  }

  count() {
    return this.all.size;
  }
}
