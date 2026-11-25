// OpenAI-compatible Chat Completions (OpenAI, xAI, Gemini, OpenRouter, Groq, Mistral, DeepSeek, Ollama/LM Studio…).
import { PROVIDERS } from './providers.js';
import { getSecret, settings } from '../core/settings.js';
import { proxiedFetch, sse, friendlyNetError } from '../core/net.js';
import { blocks, toolResultText } from './content.js';

function baseUrl(pid) {
  const p = PROVIDERS[pid];
  if (p.custom) return (settings.get().providers?.custom?.baseUrl || '').replace(/\/+$/, '');
  return p.baseUrl;
}

function headers(pid) {
  const key = getSecret(PROVIDERS[pid].secret);
  if (!key && !PROVIDERS[pid].custom) throw new Error(`Add your ${PROVIDERS[pid].label} API key in Settings → Models & keys.`);
  const h = { 'Content-Type': 'application/json' };
  if (key) h.Authorization = 'Bearer ' + key;
  if (pid === 'openrouter') { h['HTTP-Referer'] = location.origin; h['X-Title'] = 'Ai Agent'; }
  return h;
}

export function toOpenAIMessages(system, messages) {
  const out = [];
  if (system) out.push({ role: 'system', content: system });
  for (const m of messages) {
    const bl = blocks(m.content);
    if (m.role === 'assistant') {
      const text = bl.filter(b => b.type === 'text').map(b => b.text).join('');
      const calls = bl.filter(b => b.type === 'tool_use').map(b => ({ id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } }));
      const msg = { role: 'assistant', content: text || (calls.length ? null : '') };
      if (calls.length) msg.tool_calls = calls;
      out.push(msg);
    } else {
      for (const b of bl) if (b.type === 'tool_result') out.push({ role: 'tool', tool_call_id: b.tool_use_id, content: (b.is_error ? 'Error: ' : '') + toolResultText(b.content) });
      const parts = [];
      for (const b of bl) {
        if (b.type === 'text') parts.push({ type: 'text', text: b.text });
        else if (b.type === 'image') parts.push({ type: 'image_url', image_url: { url: `data:${b.source.media_type};base64,${b.source.data}` } });
        else if (b.type === 'tool_result' && Array.isArray(b.content)) for (const x of b.content) if (x.type === 'image') parts.push({ type: 'image_url', image_url: { url: `data:${x.source.media_type};base64,${x.source.data}` } });
      }
      if (parts.length) out.push({ role: 'user', content: parts.every(p => p.type === 'text') ? parts.map(p => p.text).join('\n') : parts });
    }
  }
  return out;
}

const isReasoningOpenAI = (model) => /^(o\d|gpt-5)/.test(model);

export async function openaiChat(pid, { model, system, messages, tools = [], maxTokens, temperature, signal, onEvent = () => {}, webSearch = false, thinking }) {
  const body = { model, messages: toOpenAIMessages(system, messages), stream: true };
  if (pid !== 'gemini') body.stream_options = { include_usage: true };
  if (tools.length) body.tools = tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } }));
  if (pid === 'openai' && isReasoningOpenAI(model)) {
    if (maxTokens) body.max_completion_tokens = maxTokens;
    if (thinking === 'off') body.reasoning_effort = 'minimal';
  } else {
    if (maxTokens) body.max_tokens = maxTokens;
    if (temperature != null) body.temperature = temperature;
  }
  if (webSearch && PROVIDERS[pid].webPlugin) body.plugins = [{ id: 'web' }];

  let resp;
  try {
    resp = await proxiedFetch(baseUrl(pid) + '/chat/completions', { method: 'POST', headers: headers(pid), body: JSON.stringify(body), signal });
  } catch (e) { throw new Error(friendlyNetError(e, PROVIDERS[pid].label)); }
  if (!resp.ok) {
    let msg = await resp.text().catch(() => '');
    try { const j = JSON.parse(msg); msg = j.error?.message || j.message || msg; } catch {}
    if (resp.status === 401) throw new Error(`${PROVIDERS[pid].label} rejected the API key. Check it in Settings → Models & keys.`);
    throw new Error(`${PROVIDERS[pid].label} error ${resp.status}: ${String(msg).slice(0, 400)}`);
  }

  let text = '', reasoning = '', finish = null;
  const calls = [];
  const usage = { input: 0, output: 0 };
  for await (const { data } of sse(resp, signal)) {
    if (data === '[DONE]') break;
    let j; try { j = JSON.parse(data); } catch { continue; }
    if (j.error) throw new Error(`${PROVIDERS[pid].label}: ${j.error.message || JSON.stringify(j.error)}`);
    if (j.usage) { usage.input = j.usage.prompt_tokens || usage.input; usage.output = j.usage.completion_tokens || usage.output; }
    const ch = j.choices?.[0];
    if (!ch) continue;
    const d = ch.delta || {};
    const r = d.reasoning_content ?? d.reasoning;
    if (r) { reasoning += r; onEvent({ type: 'thinking', text: r }); }
    if (d.content) { text += d.content; onEvent({ type: 'text', text: d.content }); }
    for (const tc of d.tool_calls || []) {
      const i = tc.index ?? calls.length;
      if (!calls[i]) { calls[i] = { id: tc.id || 'call_' + Math.random().toString(36).slice(2, 10), name: tc.function?.name || '', args: '' }; if (calls[i].name) onEvent({ type: 'tool_start', id: calls[i].id, name: calls[i].name }); }
      if (tc.id) calls[i].id = tc.id;
      if (tc.function?.name && !calls[i].name) { calls[i].name = tc.function.name; onEvent({ type: 'tool_start', id: calls[i].id, name: calls[i].name }); }
      if (tc.function?.arguments) { calls[i].args += tc.function.arguments; onEvent({ type: 'tool_delta', id: calls[i].id, partial: tc.function.arguments }); }
    }
    if (ch.finish_reason) finish = ch.finish_reason;
  }
  const content = [];
  if (reasoning) content.push({ type: 'thinking', thinking: reasoning });
  if (text) content.push({ type: 'text', text });
  for (const c of calls.filter(Boolean)) {
    let input = {};
    try { input = c.args ? JSON.parse(c.args) : {}; } catch { input = { _invalid_json: c.args }; }
    content.push({ type: 'tool_use', id: c.id, name: c.name, input });
  }
  const stopReason = calls.length ? 'tool_use' : finish === 'length' ? 'max_tokens' : finish === 'content_filter' ? 'refusal' : 'end_turn';
  return { content, stopReason, usage, model };
}

export async function openaiModels(pid) {
  const r = await proxiedFetch(baseUrl(pid) + '/models', { headers: headers(pid) });
  if (!r.ok) throw new Error(`${PROVIDERS[pid].label}: couldn't list models (${r.status})`);
  const j = await r.json();
  return (j.data || j.models || []).map(m => ({ id: (m.id || m.name || '').replace(/^models\//, ''), label: m.name && m.name !== m.id ? m.name : (m.id || m.name || '').replace(/^models\//, ''), context: m.context_length })).filter(m => m.id).sort((a, b) => a.id.localeCompare(b.id));
}
