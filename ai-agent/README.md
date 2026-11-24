# Ai Agent

An offline AI workspace for iPhone (built and tuned for the foldable **iPhone Duo**). It's a web app you add to your Home
Screen, and it runs local models on the phone's GPU. It has five tabs:

| Tab | What it is |
| --- | --- |
| **Agent** | A Claude Code–style coding/computer agent: tools, permission modes (ask → accept edits → plan → auto), slash commands, skills, subagents, hooks, memory, checkpoints/rewind, MCP. |
| **Code** | A Cursor-style editor: file explorer, AI panel, inline edit (select → Edit), ghost-text completion, diff review, terminal (jsh, Python, git, Linux VM), live preview. |
| **Chat** | A Grok-style assistant: DeepSearch, Think, voice mode, image input, personas, thumbs up/down that become training data. |
| **Studio** | An Unsloth-Studio–style lab: download models, build datasets, **fine-tune / train from scratch / DPO / GRPO on the phone**, evaluate, and offload big jobs to a GPU. |
| **Hub** | Every model, memory, skill, tool, dataset, knowledge base, chat and project, as plain files in one folder tree. |

Unfolded, two tabs sit side by side: drag the divider to resize, and tap a pane, then a tab in the side rail, to change
what it shows. Folded, it's one tab at a time. Settings → Appearance → *Layout when unfolded* switches between two
panes and a single pane.

## Install on your iPhone

1. **Publish it** (one time). On GitHub: *Settings → Pages → Build and deployment → Deploy from a branch*, branch
   `main`, folder `/ (root)`. After a minute it's live at `https://<your-user>.github.io/<repo>/ai-agent/`.
2. On the iPhone, open that address in **Safari**.
3. Tap **Share → Add to Home Screen**. Launch it from the Home Screen icon: it opens full screen and works offline.
4. First launch:
   - The app asks iOS to keep its storage (Settings → Storage & offline shows the result), so iOS doesn't evict your
     models.
   - The **Linux VM** installs itself in the background (the official Alpine Linux image ships with the app in
     `ai-agent/runtimes/`, 49 MB, one time). Type `linux` in the Code tab's terminal; the first start boots for about a
     minute, later starts take a second.
   - **Studio → Models**: download a model. *Qwen3 4B Instruct* (2.5 GB) is the recommended agent model. For training,
     download one from **For training** (e.g. *SmolLM2 360M* or *Qwen2.5 0.5B*).
   - Optional: **Settings → Keys** for cloud models (Anthropic, OpenAI-compatible), a Hugging Face token (private repos,
     uploads, HF Jobs) and a GitHub token (git push).
5. Keep the app in the foreground while downloading or training: iOS pauses web apps in the background. Downloads and
   training runs resume from where they stopped.

Everything is stored on the phone in the app's private storage (OPFS) under the **Hub** folder. Back it up from
Settings → Storage & offline → Export Hub (a .zip without API keys) and restore it with Import.

## The Hub

```
Hub/
  models/llm|vision|speech|tts|embeddings/<id>/   downloaded and exported models (manifest.json + files)
  models/adapters/<name>/                          LoRA adapters (PEFT format)
  memory/   MEMORY.md + facts/ people/ episodes/   what the agent remembers (markdown)
  skills/<name>/SKILL.md                           reusable instructions the agent loads when relevant
  tools/<name>/                                    custom tools (JSON schema + JS, sandboxed)
  agents/<name>.md  commands/<name>.md  hooks/     subagents, slash commands, hooks
  knowledge/<collection>/                          RAG collections (docs + hybrid BM25/embedding index)
  datasets/<name>/data.jsonl                       training data
  training/runs/<run>/                             run.json, metrics.jsonl, samples.jsonl, checkpoints/
  training/offload/                                offload job records
  chats/  workspace/<project>/  runtimes/  settings/
```

Projects can override the global Hub with their own `.hub/` folder (skills, agents, commands, memory) and an `AGENT.md`.

## Training on the phone (Studio → Train)

Forge is the app's own WebGPU training engine. It supports Llama, SmolLM2, Mistral, Qwen2/2.5 and Qwen3 architectures.

- **Methods**: SFT (LoRA, QLoRA with 4-bit NF4 base weights, or full fine-tune), continued pre-training, training a
  new model from scratch (it trains its own BPE tokenizer first), DPO preference tuning, GRPO reinforcement learning
  (built-in rewards or your own JavaScript reward function).
- **Before you start**: the estimator shows memory (weights, optimizer, activations, KV cache) against the phone's
  budget, plus time per step. That speed comes from a quick benchmark of your GPU.
- **While training**: live loss/val-loss, reward, gradient-norm and learning-rate charts, sample generations and GRPO
  rollouts. You can pause, stop, and resume from the last checkpoint.
- **After training**: try the model in the panel, then export it as a LoRA adapter (PEFT), a merged safetensors model
  (which can be trained further and chatted with in Forge), or a GGUF (q8_0/f16) that runs fastest in llama.cpp.
  Exports appear in Studio → Models and can be used as the Agent's or Chat's model.
- **Evaluate**: an A/B arena between any two models (your votes become DPO data), perplexity on a dataset, and speed.

Rough guide for the Duo: LoRA on models up to ~1.5B and QLoRA up to ~3B with short sequences. For anything bigger, use
**Offload**.

### Offload to a GPU (Studio → Offload)

The same generated Unsloth/TRL script (`train.py`) runs in four places:
- **Google Colab**: download a notebook with your data embedded, then Run all on a free T4.
- **Hugging Face Jobs**: pick a GPU. The app uploads your data to a private dataset repo, starts the job, streams logs,
  and downloads the resulting GGUF into the Hub. Needs a PRO/Team account and a write token.
- **RunPod / Modal / any CUDA machine**: a zip with `run.sh` and `modal_app.py`.
- **Companion PC**: run `ai_agent_companion.py` on your own computer and expose it over HTTPS (cloudflared, Tailscale
  Funnel or ngrok). Jobs are then sent from the phone and the GGUF is imported back.

## Tools the agent can use

Files (Read/Write/Edit/MultiEdit/Glob/Grep/LS), the jsh shell (pipes, redirects, coreutils-style commands), Python
(Pyodide, with numpy/pandas/matplotlib), sandboxed JavaScript, **git** (clone/commit/push through a CORS proxy), an
**Alpine Linux VM** (`linux <cmd>` in the terminal, or type `linux` for an interactive VM shell), web search and fetch,
documents (docx/xlsx/pptx/pdf), image and media editing (ffmpeg.wasm), iOS Shortcuts, opening URLs, the clipboard, a
browser agent, memory/recall, RAG search, the training tools (Models, Dataset, Train), subagents (Task), todos, and MCP
servers (Streamable HTTP).

## Develop

No build step for the app itself: plain ES modules + Preact/htm. Third-party libraries are pre-bundled in `vendor/`.

```bash
cd ai-agent/build
npm install --ignore-scripts      # only needed to rebuild vendor/
node vendor.mjs                   # rebuild vendor bundles
node release.mjs                  # after ANY change: updates asset-manifest.json and the service-worker version
node ../tests/serve.mjs 8080      # http://localhost:8080/ai-agent/
```

Tests use Playwright's Chromium with a software WebGPU adapter (`ai-agent/tests/`). `node tests/run.mjs` runs the fast
suites; `--all` adds the slow ones that download real models (about an hour on a CPU-emulated GPU):

| Test | Covers |
| --- | --- |
| `smoke.mjs` | service worker, cross-origin isolation, OPFS, tabs, panes |
| `models.mjs` | Hugging Face GGUF download (pause/resume), llama.cpp tool calling, embeddings |
| `agent.mjs` | agent loop with a real local model, permission prompts |
| `forge-kernels.mjs` | every WebGPU kernel against a JS reference |
| `forge-model.mjs` | Llama/Qwen2/Qwen3 forward, KV cache and gradients (finite differences), LoRA, QLoRA |
| `forge-train.mjs` | real SmolLM2-135M: LoRA SFT, exports (adapter, merged, GGUF) loaded back in Forge and llama.cpp; DPO; GRPO; from scratch |
| `runtimes.mjs` | git and the Alpine Linux VM |

See `docs/ARCHITECTURE.md` for the design.
