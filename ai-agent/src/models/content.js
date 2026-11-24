// Internal message format (Anthropic-style content blocks) and conversions.
//
// message: { role: 'user' | 'assistant', content: string | Block[] }
// Block:
//   {type:'text', text}
//   {type:'image', source:{type:'base64', media_type, data}}
//   {type:'document', source:{type:'base64', media_type:'application/pdf', data}, title?}
//   {type:'tool_use', id, name, input}
//   {type:'tool_result', tool_use_id, content: string | Block[], is_error?}
//   {type:'thinking', thinking, signature?}       (provider reasoning; replayed unchanged to the same provider)
//   any other provider-native block (server_tool_use, web_search_tool_result, redacted_thinking…) kept as-is
// tool: { name, description, input_schema }

export const blocks = (content) => typeof content === 'string' ? (content ? [{ type: 'text', text: content }] : []) : (content || []);

export function textOf(content) {
  return blocks(content).filter(b => b.type === 'text').map(b => b.text).join('');
}

export function toolResultText(content) {
  if (typeof content === 'string') return content;
  return blocks(content).map(b => b.type === 'text' ? b.text : b.type === 'image' ? '[image]' : '').join('\n');
}

export const toolUses = (content) => blocks(content).filter(b => b.type === 'tool_use');

// Flattens a conversation to plain role/text pairs (for models without tool or image support).
export function flatten(messages) {
  const out = [];
  for (const m of messages) {
    const parts = [];
    for (const b of blocks(m.content)) {
      if (b.type === 'text') parts.push(b.text);
      else if (b.type === 'tool_use') parts.push(`<tool_call>\n${JSON.stringify({ name: b.name, arguments: b.input })}\n</tool_call>`);
      else if (b.type === 'tool_result') parts.push(`<tool_response>\n${toolResultText(b.content)}\n</tool_response>`);
      else if (b.type === 'image') parts.push('[image attached]');
    }
    const text = parts.join('\n');
    if (out.length && out[out.length - 1].role === m.role) out[out.length - 1].content += '\n\n' + text;
    else out.push({ role: m.role, content: text });
  }
  return out;
}

// Minimal JSON-schema validation for tool inputs (type, required, enum, nested objects/arrays).
export function validateInput(schema, value, path = 'input') {
  if (!schema) return null;
  const t = schema.type;
  const typeOk = (tt, v) => tt === 'string' ? typeof v === 'string' : tt === 'number' ? typeof v === 'number' && isFinite(v)
    : tt === 'integer' ? Number.isInteger(v) : tt === 'boolean' ? typeof v === 'boolean' : tt === 'array' ? Array.isArray(v)
    : tt === 'object' ? v && typeof v === 'object' && !Array.isArray(v) : tt === 'null' ? v === null : true;
  if (t && !(Array.isArray(t) ? t.some(x => typeOk(x, value)) : typeOk(t, value))) return `${path} should be ${Array.isArray(t) ? t.join('|') : t}`;
  if (schema.enum && !schema.enum.includes(value)) return `${path} should be one of ${schema.enum.join(', ')}`;
  if (t === 'object' && value) {
    for (const r of schema.required || []) if (value[r] === undefined) return `${path}.${r} is required`;
    for (const [k, s] of Object.entries(schema.properties || {})) if (value[k] !== undefined) { const e = validateInput(s, value[k], `${path}.${k}`); if (e) return e; }
  }
  if (t === 'array' && Array.isArray(value) && schema.items) for (let i = 0; i < value.length; i++) { const e = validateInput(schema.items, value[i], `${path}[${i}]`); if (e) return e; }
  return null;
}

// Coerces common local-model mistakes (numbers as strings, booleans as strings) before validation.
export function coerceInput(schema, value) {
  if (!schema || value == null) return value;
  if (schema.type === 'object' && typeof value === 'object' && !Array.isArray(value)) {
    const out = { ...value };
    for (const [k, s] of Object.entries(schema.properties || {})) if (out[k] !== undefined) out[k] = coerceInput(s, out[k]);
    return out;
  }
  if ((schema.type === 'number' || schema.type === 'integer') && typeof value === 'string' && value.trim() !== '' && !isNaN(Number(value))) return Number(value);
  if (schema.type === 'boolean' && typeof value === 'string') return value === 'true' ? true : value === 'false' ? false : value;
  if (schema.type === 'array' && typeof value === 'string') { try { const v = JSON.parse(value); if (Array.isArray(v)) return v; } catch {} return [value]; }
  if (schema.type === 'string' && typeof value !== 'string' && value != null) return typeof value === 'object' ? JSON.stringify(value) : String(value);
  return value;
}

export async function fileToImageBlock(file, maxDim = 1568) {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, maxDim / Math.max(bmp.width, bmp.height));
  const w = Math.round(bmp.width * scale), h = Math.round(bmp.height * scale);
  const c = new OffscreenCanvas(w, h);
  c.getContext('2d').drawImage(bmp, 0, 0, w, h);
  const blob = await c.convertToBlob({ type: 'image/jpeg', quality: 0.88 });
  const data = await blobToBase64(blob);
  return { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data }, _w: w, _h: h };
}

export async function blobToBase64(blob) {
  const buf = new Uint8Array(await blob.arrayBuffer());
  let s = '';
  for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
  return btoa(s);
}

export function base64ToBytes(b64) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
