// Memory tools: remember/forget facts in Hub/memory and search memories + knowledge (RAG).
import * as vfs from '../../core/vfs.js';
import { parseFrontMatter, toFrontMatter } from '../../core/util.js';

const slugify = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'note';

export const Memory = {
  name: 'Memory',
  description: 'Manage long-term memory in the Hub. action "remember" saves a fact (category: facts | people | episodes, or "core" to add a line to MEMORY.md, which is always loaded); "update" rewrites a memory file; "forget" deletes one; "list" shows memories. Only store things worth remembering across conversations.',
  input_schema: { type: 'object', properties: {
    action: { type: 'string', enum: ['remember', 'update', 'forget', 'list'] },
    title: { type: 'string' }, content: { type: 'string' }, category: { type: 'string', enum: ['core', 'facts', 'people', 'episodes'] },
    path: { type: 'string', description: 'Memory file path for update/forget' }, tags: { type: 'array', items: { type: 'string' } },
  }, required: ['action'] },
  kind: 'edit', memory: true,
  summary: (i) => `${i.action}${i.title ? ': ' + i.title : ''}`,
  async run(i, ctx) {
    if (i.action === 'list') {
      const out = [];
      for (const cat of ['facts', 'people', 'episodes']) for (const e of await vfs.list(`/memory/${cat}`).catch(() => [])) out.push(`/memory/${cat}/${e.name}`);
      return out.length ? out.join('\n') : 'No memory files yet (MEMORY.md holds the core memory).';
    }
    if (i.action === 'remember') {
      if (!i.content) throw new Error('content is required');
      if (i.category === 'core' || !i.category && i.content.length < 140 && !i.title) {
        const cur = await vfs.readText('/memory/MEMORY.md').catch(() => '# Memory\n');
        await vfs.write('/memory/MEMORY.md', cur.replace(/\s*$/, '') + `\n- ${i.content.trim()}\n`);
        return { content: 'Added to MEMORY.md (always loaded).', display: { kind: 'text', text: 'Remembered: ' + i.content } };
      }
      const cat = i.category || 'facts';
      const path = `/memory/${cat}/${slugify(i.title || i.content.slice(0, 40))}.md`;
      await vfs.write(path, toFrontMatter({ title: i.title || i.content.slice(0, 60), tags: i.tags, created: new Date().toISOString() }, i.content.trim() + '\n'));
      return { content: `Saved ${path}`, display: { kind: 'text', text: 'Remembered: ' + (i.title || i.content.slice(0, 80)) } };
    }
    if (i.action === 'update') {
      if (!i.path || !i.content) throw new Error('path and content are required');
      const p = vfs.normalize(i.path, '/memory');
      if (!p.startsWith('/memory/')) throw new Error('Memory files live under /memory');
      const old = await vfs.readText(p).catch(() => '');
      const { data } = parseFrontMatter(old);
      await vfs.write(p, p.endsWith('MEMORY.md') ? i.content : toFrontMatter({ ...data, title: i.title || data.title, updated: new Date().toISOString() }, i.content.trim() + '\n'));
      return `Updated ${p}`;
    }
    if (i.action === 'forget') {
      const p = vfs.normalize(i.path || '', '/memory');
      if (!p.startsWith('/memory/') || p.endsWith('MEMORY.md')) throw new Error('Give the path of a memory file to forget (edit MEMORY.md with update).');
      await vfs.move(p, `/trash/${Date.now()}-${vfs.basename(p)}`);
      return `Moved ${p} to the trash.`;
    }
    throw new Error('Unknown action');
  },
};

export const Recall = {
  name: 'Recall',
  description: 'Search long-term memory and the knowledge base (RAG collections in Hub/knowledge) for relevant notes, facts and document passages.',
  input_schema: { type: 'object', properties: { query: { type: 'string' }, collection: { type: 'string', description: 'Knowledge collection name (optional; default searches memory and all collections)' }, k: { type: 'number' } }, required: ['query'] },
  readOnly: true, kind: 'read',
  summary: (i) => `"${i.query}"` + (i.collection ? ` in ${i.collection}` : ''),
  async run({ query, collection, k = 6 }, ctx) {
    const { search } = await import('../../rag/rag.js');
    const hits = await search(query, { collection, k, includeMemory: !collection });
    if (!hits.length) return { content: 'Nothing relevant found.', display: { kind: 'count', n: 0, noun: 'result' } };
    return {
      content: hits.map((h, i) => `[${i + 1}] ${h.source}${h.score != null ? ` (score ${h.score.toFixed(2)})` : ''}\n${h.text}`).join('\n\n---\n\n'),
      display: { kind: 'count', n: hits.length, noun: 'passage' },
    };
  },
};
