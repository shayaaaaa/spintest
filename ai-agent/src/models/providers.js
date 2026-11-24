// Cloud providers (optional; the user's own API keys, stored only in Hub/settings/secrets.json on the device).
export const PROVIDERS = {
  anthropic: {
    label: 'Anthropic', kind: 'anthropic', secret: 'anthropic_api_key', keyUrl: 'https://console.anthropic.com/settings/keys',
    models: [
      { id: 'claude-opus-5-5', label: 'Claude Opus 5.5', context: 1000000, vision: true, thinking: true, search: true },
      { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', context: 1000000, vision: true, thinking: true, search: true },
      { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5', context: 1000000, vision: true, thinking: true, search: false },
      { id: 'claude-fable-5-2', label: 'Claude Fable 5.2', context: 1000000, vision: true, thinking: true, search: true },
    ],
    default: 'claude-opus-5-5',
  },
  openai: {
    label: 'OpenAI', kind: 'openai', baseUrl: 'https://api.openai.com/v1', secret: 'openai_api_key', keyUrl: 'https://platform.openai.com/api-keys',
    models: [], default: '',
  },
  xai: {
    label: 'xAI', kind: 'openai', baseUrl: 'https://api.x.ai/v1', secret: 'xai_api_key', keyUrl: 'https://console.x.ai',
    models: [], default: '',
  },
  gemini: {
    label: 'Google Gemini', kind: 'openai', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', secret: 'gemini_api_key', keyUrl: 'https://aistudio.google.com/apikey',
    models: [], default: '',
  },
  openrouter: {
    label: 'OpenRouter', kind: 'openai', baseUrl: 'https://openrouter.ai/api/v1', secret: 'openrouter_api_key', keyUrl: 'https://openrouter.ai/keys',
    models: [], default: '', webPlugin: true,
  },
  groq: { label: 'Groq', kind: 'openai', baseUrl: 'https://api.groq.com/openai/v1', secret: 'groq_api_key', keyUrl: 'https://console.groq.com/keys', models: [], default: '' },
  mistral: { label: 'Mistral', kind: 'openai', baseUrl: 'https://api.mistral.ai/v1', secret: 'mistral_api_key', keyUrl: 'https://console.mistral.ai/api-keys', models: [], default: '' },
  deepseek: { label: 'DeepSeek', kind: 'openai', baseUrl: 'https://api.deepseek.com/v1', secret: 'deepseek_api_key', keyUrl: 'https://platform.deepseek.com/api_keys', models: [], default: '' },
  custom: { label: 'Custom (OpenAI-compatible)', kind: 'openai', baseUrl: '', secret: 'custom_api_key', models: [], default: '', custom: true },
};

export const providerIds = Object.keys(PROVIDERS);
