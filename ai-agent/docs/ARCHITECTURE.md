# Ai Agent — architecture and decisions

Offline-first AI agent environment for iPhone Duo (A20 Pro, ~12 GB RAM, 256 GB, 7.6" inner 1878x2670 + 5.4" outer
1398x2034, iOS 27, Safari WebGPU). Shipped first as a home-screen web app (PWA) in `ai-agent/` of the spintest repo,
served by GitHub Pages at `/spintest/ai-agent/`. A native app comes later and reuses the same Hub layout.

## User decisions (from the Q&A)

- Device: iPhone Duo 256 GB. Only an iPhone (no Mac/PC). Web app now, native later.
- UI: five tabs: Agent (Claude Code style), Code (Cursor style), Chat (Grok style), Studio (models/training), Hub
  (files/memory/skills/tools/RAG). Original name "Ai Agent", own icon, no third-party branding.
- Layout: both adaptive panes (unfolded = two panes) and a single-pane option.
- Permissions: switchable modes Ask / Accept edits / Plan / Auto (+ per-tool always-allow rules).
- Agent tools: everything (files + shell, JS + Python, vision + voice, web) plus Linux VM, iOS Shortcuts, browser agent,
  office/media files.
- Training: LoRA/QLoRA, from scratch, RL (GRPO/DPO), dataset studio, no hard caps but a memory/time estimator,
  pause/resume checkpoints, GPU offload (Colab notebook, HF Jobs, RunPod, Modal, companion PC script).
- Cloud models optional (user API keys): Anthropic, OpenAI, xAI, Gemini, OpenRouter, Groq, Mistral, DeepSeek, custom.
- Web access: all of: cloud model native web search, r.jina.ai reader/search, user proxy URL (Cloudflare Worker).
- Folder hierarchy: global Hub + per-project `.hub/` overrides (Claude Code style).
- One complete drop, polished and tested.

## Runtime layout

```
ai-agent/
  index.html, manifest.webmanifest, sw.js, icons/
  src/            app code (plain ES modules, no build step)
  vendor/         pre-bundled third-party ESM (built by build/vendor.mjs with esbuild)
  build/          vendor build script + package.json (node_modules ignored)
  tests/          playwright + unit tests (run from build/)
  docs/
```

- UI: Preact 10 + htm (no JSX build). State in small observable stores (`src/core/store.js`).
- Storage: OPFS. Everything user-visible lives under OPFS `/Hub`. Small settings mirrored in IndexedDB? No: settings are
  files in `Hub/settings/*.json`; API keys in `Hub/settings/secrets.json` (local only, never exported by default).
- Service worker (`sw.js`):
  - precaches the app shell; network-first for app files when online so updates land, cache fallback offline;
  - serves `./hub/<path>` URLs straight from OPFS (with Range), so every engine (WebLLM, wllama, transformers.js,
    Pyodide, v86, ffmpeg) loads files from the Hub without duplicating them in Cache Storage;
  - injects COOP/COEP (`require-corp`) on app responses for cross-origin isolation (SharedArrayBuffer for wllama
    threads, Pyodide, v86, onnxruntime threads). Cross-origin fetches use CORS, which COEP allows.
- Workers: `src/workers/forge.worker.js` (training/inference engine), `pyodide.worker.js`, `sandbox` iframe for RunJS
  (opaque origin, no storage access), VM worker.

## Hub layout (OPFS `/Hub`)

```
Hub/
  README.md
  models/
    llm/<id>/          manifest.json + engine files (mlc / gguf / onnx / safetensors)
    vision/ speech/ tts/ embeddings/
    adapters/<name>/   adapter_model.safetensors + adapter_config.json (PEFT compatible)
  memory/
    MEMORY.md          always loaded into the agent context
    facts/ people/ episodes/   one markdown file per memory, YAML front matter
  skills/<name>/SKILL.md (+ files)   progressive disclosure, Skill tool
  tools/<name>/tool.json + tool.js   custom tools run in sandbox
  agents/<name>.md      subagent definitions (front matter: name, description, tools, model)
  commands/<name>.md    custom slash commands ($ARGUMENTS)
  hooks/hooks.json      PreToolUse / PostToolUse / UserPromptSubmit / Stop (JS snippets)
  knowledge/<collection>/docs/ + index/   RAG
  datasets/<name>/ data.jsonl + meta.json
  training/runs/<run>/ config.json, log.jsonl, checkpoints/
  chats/<id>.json       conversations (agent, chat, code panel)
  runtimes/ pyodide/ linux/ ffmpeg/   on-demand downloaded runtimes
  settings/ settings.json, secrets.json, permissions.json, mcp.json
  workspace/<project>/  user projects; each may have AGENT.md and .hub/{skills,agents,commands,memory}
  trash/
```

## Model engines

| Engine | Files | Use |
| --- | --- | --- |
| WebLLM (MLC, WebGPU) | `mlc-chat-config.json`, `ndarray-cache.json`, shards, model lib `.wasm` | fastest local chat/agent |
| wllama (llama.cpp WASM, CPU threads) | `.gguf` | any GGUF from HF |
| transformers.js (ONNX, WebGPU/WASM) | `config.json`, `onnx/*.onnx`, tokenizer | embeddings, Whisper STT, TTS, vision, small LLMs |
| Forge (own WebGPU engine) | `config.json`, `*.safetensors`, `tokenizer.json` | training and inference of trained models |
| Cloud | API | optional |

All engines implement `src/models/llm.js` `chat({messages, tools, signal, onToken})` returning
`{text, toolCalls, usage, stop}`. Local tool calling uses Hermes/Qwen `<tool_call>{json}</tool_call>` prompting with a
tolerant parser; cloud uses native tool APIs.

## Forge engine (training)

- Tensors in GPU storage buffers, f32 compute; weights may be stored as packed f16 (`unpack2x16float`, core WGSL, so no
  shader-f16 requirement) or 4-bit (NF4/int4 group quant) for QLoRA.
- Tape autograd; kernels: matmul (tiled), rmsnorm, rope, causal attention, swiglu, embedding (+atomic CAS scatter-add),
  fused cross-entropy (chunked vocab), AdamW, grad norm/clip, LoRA.
- Architectures: Llama family (Llama 2/3, SmolLM2, Qwen2/2.5, Qwen3 with q/k norm, Mistral).
- Methods: SFT (full/LoRA/QLoRA), continued pretrain, pretrain from scratch (+ in-browser BPE tokenizer training), DPO
  (reference = adapters off), GRPO (group sampling, JS reward functions, KL to reference).
- Checkpoints every N steps; resume; export PEFT adapter, merged safetensors, GGUF (f16/q8_0).
- Verified against PyTorch reference outputs (tests/forge).

## Testing environment notes

- Headless Chromium here has WebGPU via SwiftShader (no shader-f16, 1 GB max binding). No WebKit available.
- Network allowlist (env "spintest"): huggingface.co + LFS/Xet hosts, cdn.jsdelivr.net, dl-cdn.alpinelinux.org,
  github.com (+ release hosts), r.jina.ai, s.jina.ai, npm, PyPI.
