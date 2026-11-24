// Minimal MCP client (Streamable HTTP transport) for remote MCP servers configured in Hub/settings/mcp.json:
// { "servers": { "name": { "url": "https://…/mcp", "headers": { "Authorization": "Bearer …" }, "enabled": true } } }
import * as vfs from '../core/vfs.js';
import { proxiedFetch, sse } from '../core/net.js';

const sessions = new Map(); // name -> {sid, tools, error}

async function rpc(name, cfg, method, params, id = Math.floor(Math.random() * 1e9)) {
  const s = sessions.get(name) || {};
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...(cfg.headers || {}) };
  if (s.sid) headers['Mcp-Session-Id'] = s.sid;
  const body = { jsonrpc: '2.0', method, ...(id != null ? { id } : {}), ...(params ? { params } : {}) };
  const r = await proxiedFetch(cfg.url, { method: 'POST', headers, body: JSON.stringify(body) });
  const sid = r.headers.get('Mcp-Session-Id');
  if (sid) sessions.set(name, { ...(sessions.get(name) || {}), sid });
  if (id == null) return null;
  if (!r.ok) throw new Error(`MCP ${name}: HTTP ${r.status}`);
  const ct = r.headers.get('content-type') || '';
  if (ct.includes('text/event-stream')) {
    for await (const ev of sse(r)) { try { const j = JSON.parse(ev.data); if (j.id === id) { if (j.error) throw new Error(j.error.message); return j.result; } } catch (e) { if (!(e instanceof SyntaxError)) throw e; } }
    throw new Error(`MCP ${name}: no response`);
  }
  const j = await r.json();
  if (j.error) throw new Error(`MCP ${name}: ${j.error.message}`);
  return j.result;
}

export async function loadMcpConfig() { return (await vfs.readJSON('/settings/mcp.json', { servers: {} })).servers || {}; }

export async function connect(name, cfg) {
  sessions.set(name, {});
  await rpc(name, cfg, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'ai-agent', version: '1.0' } });
  await rpc(name, cfg, 'notifications/initialized', null, null).catch(() => {});
  const res = await rpc(name, cfg, 'tools/list', {});
  const s = sessions.get(name);
  s.tools = res.tools || [];
  return s.tools;
}

// Returns agent tool objects for every enabled MCP server (connecting lazily; failures are reported, not thrown).
export async function mcpTools() {
  const cfgs = await loadMcpConfig();
  const out = [];
  if (!navigator.onLine) return out;
  for (const [name, cfg] of Object.entries(cfgs)) {
    if (cfg.enabled === false || !cfg.url) continue;
    let s = sessions.get(name);
    if (!s?.tools) { try { await connect(name, cfg); s = sessions.get(name); } catch (e) { sessions.set(name, { error: String(e.message || e) }); continue; } }
    for (const t of s.tools) out.push({
      name: `mcp__${name}__${t.name}`.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64),
      description: `[MCP ${name}] ${t.description || t.name}`,
      input_schema: t.inputSchema || { type: 'object', properties: {} },
      kind: t.annotations?.readOnlyHint ? 'read' : 'exec', readOnly: !!t.annotations?.readOnlyHint,
      key: () => name,
      summary: (i) => Object.values(i || {}).map(v => typeof v === 'string' ? v : '').join(' ').slice(0, 80),
      async run(input) {
        const r = await rpc(name, cfg, 'tools/call', { name: t.name, arguments: input });
        const content = (r.content || []).map(c => c.type === 'text' ? { type: 'text', text: c.text } : c.type === 'image' ? { type: 'image', source: { type: 'base64', media_type: c.mimeType, data: c.data } } : { type: 'text', text: JSON.stringify(c) });
        return { content: content.length ? content : 'Done.', isError: !!r.isError };
      },
    });
  }
  return out;
}

export function mcpStatus() { return Object.fromEntries([...sessions].map(([k, v]) => [k, { tools: v.tools?.length || 0, error: v.error || null }])); }
export function resetMcp() { sessions.clear(); }
