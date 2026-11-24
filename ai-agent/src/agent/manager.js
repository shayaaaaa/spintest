// Keeps the current session for each surface (agent, code, chat) and restores the last one on launch.
import { createStore } from '../core/store.js';
import { Session, loadIndex, sessionsIndex, deleteSession } from './session.js';
import { settings } from '../core/settings.js';

export const current = createStore({ agent: null, code: null, chat: null });
globalThis.__aiAgent = { current }; // handy for debugging and tests
let indexLoaded = null;

export async function ensureIndex() { return indexLoaded ||= loadIndex(); }

export async function getSession(kind) {
  const cur = current.get()[kind];
  if (cur) return cur;
  await ensureIndex();
  const last = sessionsIndex.get().list.find(s => s.kind === kind);
  let s = null;
  if (last && Date.now() - last.updated < 1000 * 60 * 60 * 12) { try { s = await Session.load(last.id); } catch {} }
  if (!s) s = new Session({ kind, cwd: settings.get().lastProject });
  current.set({ [kind]: s });
  return s;
}

export function newSession(kind, init = {}) {
  const prev = current.get()[kind];
  if (prev && prev.s.status !== 'idle') prev.stop();
  const s = new Session({ kind, cwd: prev?.cwd || settings.get().lastProject, model: prev?.s.model || '', mode: prev?.mode, ...init });
  current.set({ [kind]: s });
  return s;
}

export async function openSession(kind, id) {
  const prev = current.get()[kind];
  if (prev?.id === id) return prev;
  if (prev && prev.s.status !== 'idle') prev.stop();
  const s = await Session.load(id);
  current.set({ [kind]: s });
  return s;
}

export async function removeSession(kind, id) {
  await deleteSession(id);
  if (current.get()[kind]?.id === id) newSession(kind);
}

export { sessionsIndex };
