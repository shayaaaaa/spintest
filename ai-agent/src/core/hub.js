// Hub bootstrap and the global + per-project layering (like ~/.claude and <project>/.claude).
import * as vfs from './vfs.js';
import { HUB_DIRS, HUB_FILES, HUB_VERSION } from './hub-defaults.js';
import { parseFrontMatter } from './util.js';

export async function bootstrapHub() {
  const marker = '/settings/.hub-version';
  const ver = await vfs.readText(marker).catch(() => '0');
  for (const d of HUB_DIRS) await vfs.mkdir(d).catch(() => {});
  // Only seed default files on first run (or when new defaults ship); never overwrite edits.
  if (Number(ver) < HUB_VERSION) {
    for (const [path, content] of Object.entries(HUB_FILES)) await vfs.ensureFile(path, content);
    await vfs.write(marker, String(HUB_VERSION), { silent: true });
  }
}

// The project root for a path inside /workspace (e.g. /workspace/my-app/src/x.js -> /workspace/my-app).
export function projectRoot(path) {
  const p = vfs.normalize(path || '/');
  const m = /^\/workspace\/[^/]+/.exec(p);
  return m ? m[0] : null;
}

export async function listProjects() {
  const out = [];
  for (const e of await vfs.list('/workspace').catch(() => [])) if (e.kind === 'directory') out.push(e.path);
  return out;
}

// Directories to search for a kind of item, project first (project overrides global on name clash).
export function layerDirs(kind, cwd) {
  const root = projectRoot(cwd);
  const dirs = [];
  if (root) dirs.push({ dir: `${root}/.hub/${kind}`, scope: 'project' });
  dirs.push({ dir: `/${kind}`, scope: 'global' });
  return dirs;
}

// Reads markdown items with front matter (skills, agents, commands).
export async function loadMarkdownItems(kind, cwd) {
  const seen = new Map();
  for (const { dir, scope } of layerDirs(kind, cwd)) {
    let entries = [];
    try { entries = await vfs.list(dir, { details: false }); } catch { continue; }
    for (const e of entries) {
      let file = null, name = e.name.replace(/\.md$/i, '');
      if (kind === 'skills') {
        if (e.kind !== 'directory') continue;
        file = `${e.path}/SKILL.md`;
      } else {
        if (e.kind !== 'file' || !/\.md$/i.test(e.name)) continue;
        file = e.path;
      }
      let text;
      try { text = await vfs.readText(file); } catch { continue; }
      const { data, body } = parseFrontMatter(text);
      name = String(data.name || name);
      if (seen.has(name)) continue;
      seen.set(name, { name, description: String(data.description || ''), data, body, path: file, dir: kind === 'skills' ? e.path : vfs.dirname(file), scope });
    }
  }
  return [...seen.values()];
}

export async function projectMemory(cwd) {
  const root = projectRoot(cwd);
  if (!root) return null;
  for (const f of ['AGENT.md', 'CLAUDE.md', 'AGENTS.md', '.hub/AGENT.md']) {
    try { return { path: `${root}/${f}`, text: await vfs.readText(`${root}/${f}`) }; } catch {}
  }
  return null;
}
