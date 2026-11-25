// Anthropic Messages API through the official SDK (browser mode, user's own key kept on the device).
import { Anthropic } from '../../vendor/anthropic.mjs';
import { getSecret } from '../core/settings.js';
import { isOnline } from '../core/net.js';

const clients = new Map();
function client() {
  const key = getSecret('anthropic_api_key');
  if (!key) throw new Error('Add your Anthropic API key in Settings → Models & keys.');
  if (!clients.has(key)) clients.set(key, new Anthropic({ apiKey: key, dangerouslyAllowBrowser: true, maxRetries: 2 }));
  return clients.get(key);
}

// Models whose web search/fetch server tools use the dynamic-filtering variants.
const NEW_GEN = /^claude-(fable|mythos|opus-5|opus-4-[678]|sonnet-5|sonnet-4-6)/;
// Models for which server-side refusal fallbacks are enabled by default.
const FALLBACK_MODELS = /^claude-(fable-5-[12]|mythos-5-[12]|opus-5-5|opus-5$|sonnet-5-5)/;
// Older models that still take budget_tokens thinking (or none).
const LEGACY_THINKING = /^claude-(haiku-4|sonnet-4-5|opus-4-5|3)/;

// Strips app-only fields (keys starting with "_") from content blocks.
function clean(messages) {
  return messages.map(m => ({
    role: m.role,
    content: typeof m.content === 'string' ? m.content : m.content.filter(b => b.type !== 'thinking' || b.signature).map(b => {
      const o = {};
      for (const [k, v] of Object.entries(b)) if (!k.startsWith('_')) o[k] = v;
      if (o.type === 'tool_result' && Array.isArray(o.content)) o.content = o.content.map(x => { const y = {}; for (const [k, v] of Object.entries(x)) if (!k.startsWith('_')) y[k] = v; return y; });
      return o;
    }),
  })).filter(m => typeof m.content === 'string' ? m.content : m.content.length);
}

function friendlyError(e) {
  if (e instanceof Anthropic.AuthenticationError) return new Error('Anthropic rejected the API key. Check it in Settings → Models & keys.');
  if (e instanceof Anthropic.PermissionDeniedError) return new Error('This API key has no access to that model.');
  if (e instanceof Anthropic.NotFoundError) return new Error('Model not found. Pick another model.');
  if (e instanceof Anthropic.RateLimitError) return new Error('Rate limited by Anthropic. Wait a moment and try again.');
  if (e instanceof Anthropic.BadRequestError) return new Error('Anthropic: ' + (e.error?.error?.message || e.message));
  if (e instanceof Anthropic.APIError) return new Error(`Anthropic API error ${e.status ?? ''}: ${e.error?.error?.message || e.message}`);
  if (!isOnline()) return new Error("You're offline. Switch to an on-device model to keep working.");
  return e;
}

export async function anthropicChat({ model, system, messages, tools = [], maxTokens, signal, onEvent = () => {}, effort, thinking = 'auto', webSearch = false }) {
  const c = client();
  const params = {
    model,
    max_tokens: maxTokens || 64000,
    messages: clean(messages),
  };
  if (system) params.system = [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }];
  const apiTools = tools.map(t => ({ name: t.name, description: t.description, input_schema: t.input_schema, eager_input_streaming: true }));
  if (webSearch) apiTools.push(NEW_GEN.test(model) ? { type: 'web_search_20260209', name: 'web_search', max_uses: 5 } : { type: 'web_search_20250305', name: 'web_search', max_uses: 5 });
  if (apiTools.length) params.tools = apiTools;
  if (!LEGACY_THINKING.test(model)) {
    params.thinking = { type: 'adaptive', display: 'summarized' };
    const eff = thinking === 'off' ? 'low' : effort;
    if (eff) params.output_config = { effort: eff };
  } else if (thinking === 'on') {
    params.thinking = { type: 'enabled', budget_tokens: 4096 };
  }
  const useFallback = FALLBACK_MODELS.test(model);

  let content = [];
  let usage = { input: 0, output: 0 };
  let final = null;
  // pause_turn (long server-tool turns) is resumed by sending the partial assistant turn back.
  for (let round = 0; round < 4; round++) {
    let attempt = 0;
    while (true) {
      try {
        const opts = { signal };
        const stream = useFallback
          ? c.beta.messages.stream({ ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' }, opts)
          : c.messages.stream(params, opts);
        const toolIds = new Map();
        for await (const ev of stream) {
          if (ev.type === 'content_block_start') {
            const b = ev.content_block;
            if (b.type === 'tool_use') { toolIds.set(ev.index, b.id); onEvent({ type: 'tool_start', id: b.id, name: b.name }); }
            else if (b.type === 'server_tool_use') onEvent({ type: 'status', text: b.name === 'web_search' ? 'Searching the web…' : 'Using ' + b.name + '…' });
            else if (b.type === 'web_search_tool_result') onEvent({ type: 'search_results', results: Array.isArray(b.content) ? b.content.map(r => ({ title: r.title, url: r.url })) : [] });
          } else if (ev.type === 'content_block_delta') {
            const d = ev.delta;
            if (d.type === 'text_delta') onEvent({ type: 'text', text: d.text });
            else if (d.type === 'thinking_delta') onEvent({ type: 'thinking', text: d.thinking });
            else if (d.type === 'input_json_delta') onEvent({ type: 'tool_delta', id: toolIds.get(ev.index), partial: d.partial_json });
          }
        }
        final = await stream.finalMessage();
        break;
      } catch (e) {
        if (signal?.aborted) throw e;
        if (e instanceof Anthropic.APIError || attempt >= 2) throw friendlyError(e);
        // Unparseable streamed tool input or a dropped connection: re-issue the turn.
        attempt++;
        onEvent({ type: 'status', text: 'Connection hiccup, retrying…' });
      }
    }
    usage.input += (final.usage?.input_tokens || 0) + (final.usage?.cache_read_input_tokens || 0) + (final.usage?.cache_creation_input_tokens || 0);
    usage.output += final.usage?.output_tokens || 0;
    content = content.concat(final.content);
    if (final.stop_reason !== 'pause_turn') break;
    params.messages = [...params.messages, { role: 'assistant', content: final.content }];
  }
  return {
    content: content.map(b => ({ ...b })),
    stopReason: final.stop_reason,
    stopDetails: final.stop_details || null,
    usage,
    model: final.model,
  };
}

export async function anthropicModels() {
  const c = client();
  const out = [];
  for await (const m of c.models.list({ limit: 100 })) out.push({ id: m.id, label: m.display_name || m.id, context: m.max_input_tokens });
  return out;
}
