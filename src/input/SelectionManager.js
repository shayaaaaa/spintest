export class SelectionManager {
  constructor(eventBus) {
    this.eventBus = eventBus;
    this.ids = new Set();
  }

  has(id) { return this.ids.has(id); }

  set(ids) {
    this.ids = new Set(ids);
    this._notify();
  }

  clear() {
    if (this.ids.size === 0) return;
    this.ids.clear();
    this._notify();
  }

  entities(store) {
    const out = [];
    for (const id of this.ids) {
      const e = store.get(id);
      if (e) out.push(e);
    }
    return out;
  }

  // Prune selection of entities that no longer exist (died, etc).
  prune(store) {
    let changed = false;
    for (const id of this.ids) {
      if (!store.get(id)) { this.ids.delete(id); changed = true; }
    }
    if (changed) this._notify();
  }

  _notify() {
    this.eventBus.emit('selectionChanged', { ids: this.ids });
  }
}
