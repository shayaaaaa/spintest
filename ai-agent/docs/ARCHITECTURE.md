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
  runtimes/ pyodide/ linux/ ffmpeg/   runtimes (Linux installs on first launch; Python and ffmpeg on first use)
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

Files in `src/forge/`:
- `gpu.js`: device with the adapter's max limits, a buffer pool, a ring of uniform slots, and batched command encoding.
  Frees are deferred until submit. CPU-emulated adapters are detected, which disables split-K.
- `kernels.js` / `ops.js`: WGSL kernels and their wrappers.
  - Matmul: tiled 64×64, strided and batched (covers NN/NT/TN and GQA), plus split-K for long-K/small-output products.
  - GEMV: 16 rows × 4 lanes.
  - Row ops: RMSNorm fwd/bwd, causal softmax fwd/bwd, fused cross-entropy (per-row coefficients so SFT, DPO and GRPO
    share one kernel).
  - Others: RoPE (rotate-half; inverse for backward), SwiGLU fwd/bwd, embedding gather plus atomic-CAS scatter-add,
    AdamW, sum of squares.
  - Weights stay f32 for compute but can be stored as packed f16 (`unpack2x16float`, no shader-f16 needed) or NF4 with
    per-64 scales (QLoRA).
- `model.js`: Llama-family transformer (Llama 2/3 incl. llama3 RoPE scaling, SmolLM2, Mistral, Qwen2 biases, Qwen3
  QK-norm).
  - Training: activation checkpointing (keeps only each layer's input and recomputes in backward), hand-written
    backward per layer, chunked LM head/cross-entropy.
  - Inference: a KV cache with prefix reuse.
  - Parameters are named with HF/PEFT tensor names.
- `tokenizer.js`: HF tokenizers via transformers.js (chat templates), a streaming detokenizer, and a byte-level BPE
  trainer for from-scratch models.
- `data.js`: dataset shapes → labeled sequences. Assistant-only masking via template prefixes; packing for text.
- `rewards.js`: built-in GRPO rewards. Custom JavaScript rewards run in the sandbox iframe via the main thread.
- `host.js`: loading, generation, evaluation, benchmark, the training loop and exports.
  - Loop: LR warmup + cosine, gradient accumulation, clipping, checkpoints every N steps, resume, eval/samples.
  - SFT/pretrain/scratch: token-averaged CE.
  - DPO: −log σ(β·Δ) with reference log-probs precomputed (adapters off).
  - GRPO: group sampling, normalized advantages, k3 KL to the adapters-off reference.
- `export.js`: PEFT adapter config, HF→GGUF names (Q/K permutation for the llama arch), GGUF v3 writer (F32/F16/Q8_0,
  llama.cpp tokenizer metadata, chat template, llama3 `rope_freqs`).
- `client.js` + `src/workers/forge.worker.js`: the engine runs in a worker (main-thread fallback when workers lack
  WebGPU). `ForgeChatEngine` lets the model registry chat with Forge models.
- `jobs.js`: run records, the live-progress store, the memory/time estimator (measured GFLOPS), and
  start/pause/resume/export.
- `offload.js`: one generated Unsloth/TRL `train.py` for Colab (.ipynb), HF Jobs (REST API), RunPod/Modal (zip) and a
  companion FastAPI server.

Verification:
- Kernels vs JS references (`tests/forge-kernels.mjs`).
- Whole-model forward, KV cache and every parameter's gradient vs finite differences on tiny Llama/Qwen2/Qwen3
  (`tests/forge-model.mjs`).
- End to end on SmolLM2-135M, with merged/GGUF exports checked in Forge and llama.cpp (`tests/forge-train.mjs`).

## First-run setup

`src/core/setup.js` installs everything once, automatically, a few seconds after the first launch:
- **Steps:** offline engine cache (service worker), Linux VM (install + first boot), Python with numpy/pandas/matplotlib,
  ffmpeg, and the MiniLM search model.
- **Chat models:** never downloaded automatically; the user picks them in Studio → Models. A one-time cleanup
  removes an unfinished Qwen3 4B download started by an earlier version (a finished one is kept).
- **Records:** each finished step is recorded in settings (`setup.steps`) and never repeats; a failed step is retried
  on the next launch, and the run waits for `online` when offline.
- **UI:** `src/ui/setup-bar.js` shows progress (bar above the tabs plus a checklist sheet).
- **Settings:** the Settings card can turn it off or reinstall anything missing (`runSetup({force:true})` checks real
  presence instead of the flags).
- **Linux:** once it is set up, jsh runs unknown commands in the VM (`linuxEnabled`), re-quoting arguments.

## Shell runtimes

- `src/shell/jsh.js`: POSIX-like shell over the Hub (pipes, redirects, globbing, coreutils-style commands).
- `src/runtimes/python.js`: Pyodide in a worker. `pip install` uses the Pyodide distribution, plus micropip.
- `src/runtimes/git.js`: isomorphic-git over an OPFS `fs.promises` adapter. Network goes through the user's proxy or
  the isomorphic-git CORS proxy; tokens come from Settings → Keys.
- `src/runtimes/linux.js`: Alpine Linux (official x86 *virt* ISO, SHA-256 verified) in v86, driven over the serial
  console with exit-status markers. A snapshot after first boot makes later starts take seconds. `--put`/`--get`
  move files between the Hub and the VM. The Alpine mirror sends no CORS headers, so the official ISO ships with the
  app (`ai-agent/runtimes/alpine.iso` + `alpine.json` with its SHA-256). On first launch `autoSetup()` copies it into the Hub
  and then `prepare()` boots it once in the background, saves the snapshot (~140 MB), and stops the VM again. This
  is skipped under automation or after the user removed Linux; the install also waits while offline or in Data
  Saver. A snapshot that can't be restored (bad header, other emulator version) is discarded and replaced by a fresh
  boot. The
  fallbacks are the user's proxy, a direct download, or importing an ISO file.

## Testing environment notes

- Headless Chromium here has WebGPU via SwiftShader (no shader-f16, 1 GB max binding). No WebKit available.
- Network allowlist (env "spintest"): huggingface.co + LFS/Xet hosts, cdn.jsdelivr.net, dl-cdn.alpinelinux.org,
  github.com (+ release hosts), r.jina.ai, s.jina.ai, npm, PyPI.
