// Minimal observable stores with a Preact hook.
import { useState, useEffect, useRef } from '../../vendor/preact.mjs';

export function createStore(initial) {
  let state = initial;
  const subs = new Set();
  return {
    get: () => state,
    set(patch) {
      const next = typeof patch === 'function' ? patch(state) : { ...state, ...patch };
      if (next === state) return;
      state = next;
      for (const fn of [...subs]) fn(state);
    },
    replace(next) { state = next; for (const fn of [...subs]) fn(state); },
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
  };
}

const shallowEq = (a, b) => {
  if (Object.is(a, b)) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) if (!Object.is(a[k], b[k])) return false;
  return true;
};

export function useStore(store, selector = (s) => s) {
  const [, force] = useState(0);
  const sel = useRef(selector);
  sel.current = selector;
  const val = useRef(selector(store.get()));
  val.current = selector(store.get());
  useEffect(() => store.subscribe((s) => {
    const next = sel.current(s);
    if (!shallowEq(next, val.current)) { val.current = next; force(n => n + 1); }
  }), [store]);
  return val.current;
}

// Re-render on an Emitter event.
export function useEvent(emitter, ev, fn, deps = []) {
  useEffect(() => emitter.on(ev, fn), deps);
}
