// Curated starting points (all verified on Hugging Face). The Studio can also search and download any repo.
// sizeGB = download size. Tool use: "native" = trained for tool calling.

export const GGUF_CATALOG = [
  { name: 'Qwen3 4B Instruct 2507', repo: 'unsloth/Qwen3-4B-Instruct-2507-GGUF', file: 'Qwen3-4B-Instruct-2507-Q4_K_M.gguf', sizeGB: 2.5, params: '4B', context: 8192, tags: ['agent', 'tools', 'recommended'], blurb: 'Best all-round on-device agent model. Strong tool use and coding.' },
  { name: 'Qwen3 4B Thinking 2507', repo: 'unsloth/Qwen3-4B-Thinking-2507-GGUF', file: 'Qwen3-4B-Thinking-2507-Q4_K_M.gguf', sizeGB: 2.5, params: '4B', context: 8192, tags: ['reasoning', 'tools'], blurb: 'Thinks step by step before answering. Slower, better at math and logic.' },
  { name: 'Qwen3 1.7B', repo: 'unsloth/Qwen3-1.7B-GGUF', file: 'Qwen3-1.7B-Q4_K_M.gguf', sizeGB: 1.1, params: '1.7B', context: 8192, tags: ['fast', 'tools'], blurb: 'Fast agent and chat model with thinking mode.' },
  { name: 'Qwen3 0.6B', repo: 'unsloth/Qwen3-0.6B-GGUF', file: 'Qwen3-0.6B-Q4_K_M.gguf', sizeGB: 0.4, params: '0.6B', context: 8192, tags: ['tiny', 'tools'], blurb: 'Tiny and very fast. Good for autocomplete, titles and simple tasks.' },
  { name: 'Qwen3 8B', repo: 'unsloth/Qwen3-8B-GGUF', file: 'Qwen3-8B-Q4_K_M.gguf', sizeGB: 5.0, params: '8B', context: 4096, tags: ['large', 'tools'], blurb: 'Smartest model that fits; slower and uses most of the memory.' },
  { name: 'Qwen2.5 Coder 7B', repo: 'unsloth/Qwen2.5-Coder-7B-Instruct-GGUF', file: 'Qwen2.5-Coder-7B-Instruct-Q4_K_M.gguf', sizeGB: 4.7, params: '7B', context: 4096, tags: ['code', 'large'], blurb: 'Strong code model for the Code tab.' },
  { name: 'Qwen2.5 Coder 3B', repo: 'unsloth/Qwen2.5-Coder-3B-Instruct-GGUF', file: 'Qwen2.5-Coder-3B-Instruct-Q4_K_M.gguf', sizeGB: 1.9, params: '3B', context: 8192, tags: ['code'], blurb: 'Good code model, balanced speed.' },
  { name: 'Qwen2.5 Coder 1.5B', repo: 'unsloth/Qwen2.5-Coder-1.5B-Instruct-GGUF', file: 'Qwen2.5-Coder-1.5B-Instruct-Q4_K_M.gguf', sizeGB: 1.0, params: '1.5B', context: 8192, tags: ['code', 'fast'], blurb: 'Fast code completion (ghost text) in the editor.' },
  { name: 'Gemma 3 4B (vision)', repo: 'unsloth/gemma-3-4b-it-qat-GGUF', file: 'gemma-3-4b-it-qat-Q4_0.gguf', mmproj: 'mmproj-F16.gguf', sizeGB: 3.2, params: '4B', context: 8192, tags: ['vision', 'chat'], blurb: 'Sees images and photos. Great writing and multilingual chat.' },
  { name: 'Gemma 3 1B', repo: 'unsloth/gemma-3-1b-it-GGUF', file: 'gemma-3-1b-it-Q4_K_M.gguf', sizeGB: 0.8, params: '1B', context: 8192, tags: ['fast', 'chat'], blurb: 'Small, friendly chat model.' },
  { name: 'Gemma 3n E2B', repo: 'unsloth/gemma-3n-E2B-it-GGUF', file: 'gemma-3n-E2B-it-Q4_K_M.gguf', sizeGB: 3.0, params: '5B (2B active)', context: 8192, tags: ['chat'], blurb: 'Efficient mobile-first model from Google.' },
  { name: 'Llama 3.2 3B', repo: 'unsloth/Llama-3.2-3B-Instruct-GGUF', file: 'Llama-3.2-3B-Instruct-Q4_K_M.gguf', sizeGB: 2.0, params: '3B', context: 8192, tags: ['chat', 'tools'], blurb: 'Meta Llama 3.2, solid general assistant.' },
  { name: 'Llama 3.2 1B', repo: 'unsloth/Llama-3.2-1B-Instruct-GGUF', file: 'Llama-3.2-1B-Instruct-Q4_K_M.gguf', sizeGB: 0.8, params: '1B', context: 8192, tags: ['fast'], blurb: 'Small Llama for quick tasks.' },
  { name: 'Phi-4 mini', repo: 'unsloth/Phi-4-mini-instruct-GGUF', file: 'Phi-4-mini-instruct-Q4_K_M.gguf', sizeGB: 2.5, params: '3.8B', context: 8192, tags: ['reasoning'], blurb: 'Microsoft Phi-4 mini: math and reasoning.' },
  { name: 'SmolLM3 3B', repo: 'unsloth/SmolLM3-3B-GGUF', file: 'SmolLM3-3B-Q4_K_M.gguf', sizeGB: 1.9, params: '3B', context: 8192, tags: ['reasoning', 'tools'], blurb: 'Open-data model with dual thinking mode.' },
  { name: 'DeepSeek R1 Distill 1.5B', repo: 'unsloth/DeepSeek-R1-Distill-Qwen-1.5B-GGUF', file: 'DeepSeek-R1-Distill-Qwen-1.5B-Q4_K_M.gguf', sizeGB: 1.1, params: '1.5B', context: 8192, tags: ['reasoning'], blurb: 'Small reasoning model (long chains of thought).' },
  { name: 'LFM2 1.2B', repo: 'LiquidAI/LFM2-1.2B-GGUF', file: 'LFM2-1.2B-Q4_K_M.gguf', sizeGB: 0.7, params: '1.2B', context: 8192, tags: ['fast', 'tools'], blurb: 'Very fast on phones, good at tool calls.' },
  { name: 'Qwen2.5-VL 3B (vision)', repo: 'ggml-org/Qwen2.5-VL-3B-Instruct-GGUF', file: 'Qwen2.5-VL-3B-Instruct-Q4_K_M.gguf', mmproj: 'mmproj-Qwen2.5-VL-3B-Instruct-Q8_0.gguf', sizeGB: 2.8, params: '3B', context: 8192, tags: ['vision'], blurb: 'Reads screenshots, documents and photos.' },
  { name: 'SmolVLM2 2.2B (vision)', repo: 'ggml-org/SmolVLM2-2.2B-Instruct-GGUF', file: 'SmolVLM2-2.2B-Instruct-Q4_K_M.gguf', mmproj: 'mmproj-SmolVLM2-2.2B-Instruct-Q8_0.gguf', sizeGB: 1.7, params: '2.2B', context: 8192, tags: ['vision', 'fast'], blurb: 'Small, quick image understanding.' },
];

// Bases for training in the Forge engine (safetensors, Llama/Qwen architectures).
export const TRAIN_CATALOG = [
  { name: 'SmolLM2 135M Instruct', repo: 'HuggingFaceTB/SmolLM2-135M-Instruct', params: 135e6, blurb: 'Fastest to fine-tune; good for experiments and learning.' },
  { name: 'SmolLM2 360M Instruct', repo: 'HuggingFaceTB/SmolLM2-360M-Instruct', params: 362e6, blurb: 'Small but capable; full fine-tune or LoRA.' },
  { name: 'Qwen2.5 0.5B Instruct', repo: 'Qwen/Qwen2.5-0.5B-Instruct', params: 494e6, blurb: 'Strong small base; LoRA fine-tunes in minutes.' },
  { name: 'Qwen3 0.6B', repo: 'Qwen/Qwen3-0.6B', params: 596e6, blurb: 'Qwen3 with thinking; great for GRPO experiments.' },
  { name: 'Llama 3.2 1B Instruct', repo: 'unsloth/Llama-3.2-1B-Instruct', params: 1.24e9, blurb: 'Llama base for LoRA/QLoRA.' },
  { name: 'Qwen2.5 1.5B Instruct', repo: 'Qwen/Qwen2.5-1.5B-Instruct', params: 1.54e9, blurb: 'LoRA comfortable, QLoRA recommended.' },
  { name: 'SmolLM2 1.7B Instruct', repo: 'HuggingFaceTB/SmolLM2-1.7B-Instruct', params: 1.71e9, blurb: 'QLoRA recommended.' },
  { name: 'Qwen3 1.7B', repo: 'Qwen/Qwen3-1.7B', params: 2.03e9, blurb: 'QLoRA; slow but works on the Duo.' },
  { name: 'Llama 3.2 3B Instruct', repo: 'unsloth/Llama-3.2-3B-Instruct', params: 3.21e9, blurb: 'QLoRA only, short sequences; or offload to a GPU.' },
  { name: 'Qwen3 4B', repo: 'Qwen/Qwen3-4B', params: 4.02e9, blurb: 'QLoRA with short context; offload recommended.' },
];

// transformers.js models for speech, embeddings, vision and small ONNX LLMs.
export const ONNX_CATALOG = [
  { name: 'MiniLM L6 (embeddings)', repo: 'Xenova/all-MiniLM-L6-v2', kind: 'embeddings', sizeGB: 0.023, blurb: 'Fast English embeddings for RAG and memory search. Default.' },
  { name: 'BGE small (embeddings)', repo: 'Xenova/bge-small-en-v1.5', kind: 'embeddings', sizeGB: 0.034, blurb: 'Better English retrieval quality.' },
  { name: 'EmbeddingGemma 300M', repo: 'onnx-community/embeddinggemma-300m-ONNX', kind: 'embeddings', sizeGB: 0.2, blurb: 'Multilingual, highest quality embeddings.' },
  { name: 'Whisper tiny (English)', repo: 'onnx-community/whisper-tiny.en', kind: 'speech', sizeGB: 0.05, blurb: 'Fast English speech-to-text.' },
  { name: 'Whisper base', repo: 'onnx-community/whisper-base', kind: 'speech', sizeGB: 0.08, blurb: 'Multilingual speech-to-text.' },
  { name: 'Whisper small', repo: 'onnx-community/whisper-small', kind: 'speech', sizeGB: 0.25, blurb: 'Most accurate; slower.' },
  { name: 'Kokoro 82M (voice)', repo: 'onnx-community/Kokoro-82M-v1.0-ONNX', kind: 'tts', sizeGB: 0.09, blurb: 'Natural text-to-speech voices.' },
  { name: 'SmolVLM 256M (vision)', repo: 'HuggingFaceTB/SmolVLM-256M-Instruct', kind: 'vision', sizeGB: 0.25, blurb: 'Tiny image description model; lets any LLM "see" via captions.' },
  { name: 'SmolVLM 500M (vision)', repo: 'HuggingFaceTB/SmolVLM-500M-Instruct', kind: 'vision', sizeGB: 0.5, blurb: 'Better image descriptions.' },
  { name: 'Qwen3 0.6B (ONNX)', repo: 'onnx-community/Qwen3-0.6B-ONNX', kind: 'llm', sizeGB: 0.5, blurb: 'Runs on the ONNX engine; alternative to GGUF.' },
];

// Rough runtime memory need (GB) for a quantized model: weights + KV cache + overhead.
export function memNeedGB(sizeGB, context = 4096, params) {
  const p = typeof params === 'string' ? parseFloat(params) : (params || sizeGB * 1.8);
  const kv = (p > 6 ? 0.14 : p > 3 ? 0.1 : 0.06) * (context / 1024) * 0.5;
  return sizeGB * 1.08 + kv + 0.35;
}

export function fitRating(needGB, budgetGB = 12) {
  // iOS gives a single web page roughly half of the device RAM before it's killed.
  const usable = budgetGB * 0.5;
  if (needGB <= usable * 0.55) return { label: 'Runs great', cls: 'ok' };
  if (needGB <= usable * 0.8) return { label: 'Runs well', cls: 'ok' };
  if (needGB <= usable) return { label: 'Tight fit', cls: 'warn' };
  return { label: 'Probably too big', cls: 'err' };
}
