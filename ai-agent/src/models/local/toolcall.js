// Tool calling for local models that lack a native tool API: Hermes/Qwen-style prompt + tolerant streaming parser.
import { blocks, toolResultText } from '../content.js';
import { extractJSON, uid } from '../../core/util.js';

export function toolsPrompt(tools) {
  if (!tools?.length) return '';
  const sigs = tools.map(t => JSON.stringify({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } })).join('\n');
  return `\n\n# Tools\n\nYou may call one or more functions to assist with the user query.\n\nYou are provided with function signatures within <tools></tools> XML tags:\n<tools>\n${sigs}\n</tools>\n\nFor each function call, return a json object with function name and arguments within <tool_call></tool_call> XML tags:\n<tool_call>\n{"name": <function-name>, "arguments": <args-json-object>}\n</tool_call>\n\nAfter calling tools, stop and wait: results arrive in <tool_response></tool_response> tags.`;
}

// Converts internal messages to plain chat messages with tool calls/results embedded as text.
export function toTextChat(system, messages, { images = false } = {}) {
  const out = [];
  if (system) out.push({ role: 'system', content: system });
  for (const m of messages) {
    const parts = [];
    const imgs = [];
    for (const b of blocks(m.content)) {
      if (b.type === 'text') parts.push(b.text);
      else if (b.type === 'tool_use') parts.push(`<tool_call>\n${JSON.stringify({ name: b.name, arguments: b.input })}\n</tool_call>`);
      else if (b.type === 'tool_result') parts.push(`<tool_response>\n${(b.is_error ? 'Error: ' : '') + toolResultText(b.content)}\n</tool_response>`);
      else if (b.type === 'image') { if (images) imgs.push(b); else parts.push('[an image was attached, but this model cannot see images]'); }
    }
    const content = parts.join('\n');
    const prev = out[out.length - 1];
    if (prev && prev.role === m.role && !imgs.length && !prev._imgs) prev.content += '\n\n' + content;
    else out.push(imgs.length ? { role: m.role, content, _imgs: imgs } : { role: m.role, content });
  }
  return out;
}

const TAGS = ['<think>', '</think>', '<tool_call>', '</tool_call>'];

// Streaming splitter: routes text into visible text / thinking / tool-call buffers, holding back partial tags.
export class StreamSplitter {
  constructor(onEvent, { startInThinking = false } = {}) {
    this.onEvent = onEvent;
    this.mode = startInThinking ? 'think' : 'text';
    this.pending = '';
    this.text = ''; this.thinking = ''; this.calls = []; this.cur = '';
  }
  push(chunk) {
    this.pending += chunk;
    while (this.pending) {
      let idx = -1, tag = null;
      for (const t of TAGS) { const i = this.pending.indexOf(t); if (i >= 0 && (idx < 0 || i < idx)) { idx = i; tag = t; } }
      if (idx < 0) {
        // keep a possible partial tag at the end
        let keep = 0;
        for (const t of TAGS) for (let k = Math.min(t.length - 1, this.pending.length); k > 0; k--) if (this.pending.endsWith(t.slice(0, k))) { keep = Math.max(keep, k); break; }
        const emit = this.pending.slice(0, this.pending.length - keep);
        this.pending = this.pending.slice(this.pending.length - keep);
        this._emit(emit);
        return;
      }
      this._emit(this.pending.slice(0, idx));
      this.pending = this.pending.slice(idx + tag.length);
      if (tag === '<think>') this.mode = 'think';
      else if (tag === '</think>') this.mode = 'text';
      else if (tag === '<tool_call>') { this.mode = 'call'; this.cur = ''; this.onEvent({ type: 'status', text: 'Preparing a tool call…' }); }
      else if (tag === '</tool_call>') { this.calls.push(this.cur); this.cur = ''; this.mode = 'text'; }
    }
  }
  _emit(s) {
    if (!s) return;
    if (this.mode === 'text') { this.text += s; this.onEvent({ type: 'text', text: s }); }
    else if (this.mode === 'think') { this.thinking += s; this.onEvent({ type: 'thinking', text: s }); }
    else this.cur += s;
  }
  finish() {
    if (this.pending) { const p = this.pending; this.pending = ''; this._emit(p); }
    if (this.mode === 'call' && this.cur.trim()) this.calls.push(this.cur);
    return this.result();
  }
  result() {
    const content = [];
    if (this.thinking.trim()) content.push({ type: 'thinking', thinking: this.thinking.trim() });
    let text = this.text;
    const calls = [];
    for (const raw of this.calls) { const c = parseCall(raw); if (c) calls.push(c); }
    // Fallback: some models write a bare JSON call (or a fenced one) instead of the tags.
    if (!calls.length && this._toolNames?.size) {
      const j = extractJSON(text);
      if (j && typeof j === 'object' && !Array.isArray(j) && this._toolNames.has(j.name) && (j.arguments || j.parameters)) {
        calls.push({ name: j.name, input: normalizeArgs(j.arguments ?? j.parameters) });
        text = text.replace(/```(?:json)?\s*[\s\S]*?```/, '').replace(/\{[\s\S]*\}/, '').trim();
      }
    }
    if (text.trim()) content.push({ type: 'text', text: text.trim() });
    for (const c of calls) content.push({ type: 'tool_use', id: 'toolu_' + uid(), name: c.name, input: c.input });
    return { content, hasCalls: calls.length > 0 };
  }
  expectTools(tools) { this._toolNames = new Set((tools || []).map(t => t.name)); return this; }
}

function normalizeArgs(a) {
  if (typeof a === 'string') { try { return JSON.parse(a); } catch { return { value: a }; } }
  return a && typeof a === 'object' ? a : {};
}

export function parseCall(raw) {
  const j = extractJSON(raw);
  if (!j || typeof j !== 'object') return null;
  const name = j.name || j.function?.name || j.tool;
  if (!name) return null;
  return { name, input: normalizeArgs(j.arguments ?? j.parameters ?? j.function?.arguments ?? j.input ?? {}) };
}
