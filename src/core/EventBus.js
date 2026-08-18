// Minimal publish/subscribe hub so systems, AI, and UI can react to game
// events without importing each other directly.
export class EventBus {
  constructor() {
    this.listeners = new Map(); // eventName -> Set<fn>
  }

  on(eventName, fn) {
    if (!this.listeners.has(eventName)) this.listeners.set(eventName, new Set());
    this.listeners.get(eventName).add(fn);
    return () => this.off(eventName, fn);
  }

  off(eventName, fn) {
    this.listeners.get(eventName)?.delete(fn);
  }

  emit(eventName, payload) {
    const set = this.listeners.get(eventName);
    if (!set) return;
    for (const fn of set) fn(payload);
  }
}
