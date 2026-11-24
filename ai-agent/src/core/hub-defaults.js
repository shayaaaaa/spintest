// Files created in a fresh Hub. Existing files are never overwritten.
export const HUB_VERSION = 1;

export const HUB_DIRS = [
  '/models/llm', '/models/vision', '/models/speech', '/models/tts', '/models/embeddings', '/models/adapters',
  '/memory/facts', '/memory/people', '/memory/episodes',
  '/skills', '/tools', '/agents', '/commands', '/hooks',
  '/knowledge', '/datasets', '/training/runs', '/chats', '/runtimes', '/settings', '/workspace', '/trash', '/inbox',
];

export const HUB_FILES = {
  '/README.md': `# Your Hub

Everything Ai Agent uses lives in this folder, so it's easy to read, add, update and back up.

| Folder | What's inside |
| --- | --- |
| \`models/llm\` | Language models you downloaded or trained (one folder per model, with \`manifest.json\`) |
| \`models/vision\`, \`speech\`, \`tts\`, \`embeddings\` | Image, speech-to-text, text-to-speech and embedding models |
| \`models/adapters\` | LoRA adapters from fine-tuning (PEFT format, also usable on a PC) |
| \`memory\` | \`MEMORY.md\` is always loaded. \`facts/\`, \`people/\`, \`episodes/\` hold one memory per file |
| \`skills\` | Skills: a folder with \`SKILL.md\` (instructions the agent loads when relevant) plus any helper files |
| \`tools\` | Custom tools: \`tool.json\` (name, description, input schema) and \`tool.js\` (runs in a sandbox) |
| \`agents\` | Subagents: markdown files with a name, description, tools and a system prompt |
| \`commands\` | Your slash commands: \`commands/review.md\` becomes \`/review\` (\`$ARGUMENTS\` is replaced) |
| \`hooks\` | \`hooks.json\`: scripts that run before/after tools or when you send a prompt |
| \`knowledge\` | RAG collections: put files in \`<collection>/docs\`, the index is built in \`<collection>/index\` |
| \`datasets\` | Training datasets (\`data.jsonl\` + \`meta.json\`) |
| \`training/runs\` | Training runs: config, logs, checkpoints |
| \`chats\` | Saved conversations |
| \`runtimes\` | Python, Linux and ffmpeg, downloaded on first use |
| \`settings\` | \`settings.json\`, \`permissions.json\`, \`mcp.json\` and \`secrets.json\` (API keys, stays on this phone) |
| \`workspace\` | Your projects. A project can have its own \`AGENT.md\` and a \`.hub/\` folder with project-only skills, agents, commands and memory |
| \`inbox\` | Files shared or imported into the app land here first |
| \`trash\` | Deleted files go here first |
`,

  '/memory/MEMORY.md': `# Memory

This file is loaded into every conversation. Keep it short: preferences, facts about you, and how you like to work.
The agent adds to it when you say "remember …" (or use /memory).

## About me
- (Tell the agent about yourself here.)

## Preferences
- Be concise. Show code changes as diffs.
`,

  '/settings/permissions.json': JSON.stringify({
    mode: 'ask',
    allow: ['Read', 'Glob', 'Grep', 'LS', 'TodoWrite', 'Skill', 'AskUser', 'MemorySearch', 'KnowledgeSearch', 'ViewImage'],
    deny: [],
    ask: [],
  }, null, 2),

  '/settings/mcp.json': JSON.stringify({ servers: {} }, null, 2),

  '/hooks/hooks.json': JSON.stringify({
    _help: 'Each hook is JavaScript run in a sandbox. It receives `event` and returns {decision:"block", reason} to stop a tool, or {message} to add a note. Events: PreToolUse, PostToolUse, UserPromptSubmit, Stop.',
    PreToolUse: [],
    PostToolUse: [],
    UserPromptSubmit: [],
    Stop: [],
  }, null, 2),

  '/skills/skill-creator/SKILL.md': `---
name: skill-creator
description: Create or improve a skill (a reusable set of instructions in Hub/skills). Use when the user asks to make a new skill, teach the agent a workflow, or save a procedure for later.
---

# Creating a skill

A skill is a folder in \`~/skills/<name>/\` (global) or \`<project>/.hub/skills/<name>/\` (project only) containing \`SKILL.md\`.

1. Ask what the skill should do and when it should trigger, unless that's already clear.
2. Write \`SKILL.md\` with front matter:
   \`\`\`
   ---
   name: short-kebab-name
   description: One or two sentences: what it does AND when to use it. This is all the agent sees until it loads the skill.
   ---
   \`\`\`
3. The body holds the instructions: steps, rules, examples, pitfalls. Keep it under ~400 lines; put long references in
   extra files next to SKILL.md and mention them so they're read only when needed.
4. Helper scripts (JS or Python) can live in the folder and be run with the RunJS or Python tools.
5. Tell the user the skill name and how it triggers.
`,

  '/skills/tool-creator/SKILL.md': `---
name: tool-creator
description: Create a new custom tool the agent can call (a JavaScript function with a JSON input schema in Hub/tools). Use when the user wants a reusable capability that should be a tool rather than instructions.
---

# Creating a custom tool

A tool is a folder \`~/tools/<name>/\` with two files:

\`tool.json\`
\`\`\`json
{
  "name": "WordCount",
  "description": "Counts words, lines and characters in a text.",
  "input_schema": { "type": "object", "properties": { "text": { "type": "string" } }, "required": ["text"] }
}
\`\`\`

\`tool.js\` defines \`async function run(input, ctx)\` and returns a string or JSON-serializable value. It runs in a
sandbox with no network or storage access, except through \`ctx\`: \`await ctx.readFile(path)\`,
\`await ctx.writeFile(path, text)\`, \`await ctx.fetch(url)\` (only when online and allowed).

\`\`\`js
async function run({ text }) {
  return { words: text.trim().split(/\\s+/).filter(Boolean).length, lines: text.split('\\n').length, chars: text.length };
}
\`\`\`

After creating it, the tool is available from the next message. Test it once by calling it.
`,

  '/skills/web-research/SKILL.md': `---
name: web-research
description: Research a question on the web with search and page reading, then answer with citations. Use for current events, facts you're unsure of, comparisons, or anything needing sources.
---

# Web research

1. Break the question into 2–4 focused searches. Run WebSearch for each.
2. Open the 3–6 most relevant results with WebFetch. Prefer primary sources (official sites, papers, docs).
3. Cross-check facts that matter across at least two sources. Note disagreements instead of hiding them.
4. Answer directly first, then supporting detail. Cite sources as markdown links right after the claims they support.
5. If you're offline, say so and answer from memory, clearly marked as possibly outdated.
`,

  '/skills/office-documents/SKILL.md': `---
name: office-documents
description: Create or read Word (.docx), Excel (.xlsx), PowerPoint (.pptx) and PDF files. Use whenever the user asks for a document, spreadsheet, slide deck or PDF, or gives you one to read.
---

# Office documents

Use the **Document** tool:

- \`action: "create"\`, \`format: "docx" | "xlsx" | "pptx" | "pdf"\`, \`path\`, and \`content\`:
  - docx/pdf: markdown (headings, paragraphs, lists, tables, bold/italic).
  - xlsx: \`{ "sheets": [{ "name": "Sheet1", "rows": [["Header", "…"], [1, 2]] }] }\`. Formulas as strings starting with "=".
  - pptx: \`{ "slides": [{ "title": "…", "bullets": ["…"], "notes": "…" }] }\`.
- \`action: "read"\`, \`path\`: returns the text (and tables for xlsx).

Tips: give documents a clear title, use real headings, keep slides to 3–6 bullets, and put files in the project folder
unless the user names another place. After creating, tell the user the path.
`,

  '/skills/frontend-design/SKILL.md': `---
name: frontend-design
description: Build polished, responsive web pages and small web apps (HTML/CSS/JS). Use when the user asks for a website, landing page, UI, game or visual prototype.
---

# Frontend design

- Start with structure (semantic HTML), then a small design system: CSS variables for color, spacing, radius, type scale.
- Support light and dark (\`prefers-color-scheme\`), phone widths first (16px gutters), no horizontal scroll.
- No external CDNs unless the user is online and asks; everything should work offline.
- Keep JS in modules, avoid frameworks for small pages.
- After writing files, open them with the Preview tool (or tell the user to tap Preview in the Code tab) and fix what looks off.
`,

  '/skills/model-training/SKILL.md': `---
name: model-training
description: Plan and run fine-tuning, training from scratch, or reinforcement learning (DPO/GRPO) on this phone with the Studio, including dataset preparation. Use when the user wants to train, fine-tune or teach a model.
---

# Training a model

1. Clarify the goal: style/persona, a task (classification, extraction), knowledge, or reasoning (GRPO).
2. Dataset: use the Dataset tool. Chat SFT rows are \`{"messages":[{"role":"user","content":…},{"role":"assistant","content":…}]}\`.
   DPO rows: \`{"prompt":…, "chosen":…, "rejected":…}\`. GRPO rows: \`{"prompt":…, "answer":…}\` plus a reward function.
   Aim for 200–2,000 good examples for LoRA; quality beats quantity.
3. Pick a base model that fits (Studio → Estimate). On this phone: LoRA up to ~1.5B is comfortable, QLoRA to ~4B, more is slow.
4. Defaults that work: LoRA rank 16, alpha 32, lr 2e-4, 1–3 epochs, seq length 512–1024, batch 1 with grad accumulation 8.
5. Start the run with the Train tool, then check the loss curve. Loss that falls then flattens is good; rising validation loss means overfitting.
6. Test the result in Chat with the adapter selected. For bigger jobs, use Offload (Colab, HF Jobs, RunPod) from the Studio.
`,

  '/agents/explorer.md': `---
name: explorer
description: Fast read-only search agent. Use it to find files, symbols or facts across a project or the Hub when the answer needs many searches but only a short conclusion.
tools: [Read, Glob, Grep, LS]
---

You are a search specialist. Find what was asked using Glob, Grep, LS and Read. Read excerpts, not whole large files.
Report the answer concisely with file paths and line numbers. Do not modify anything.
`,

  '/agents/reviewer.md': `---
name: reviewer
description: Reviews code changes or a file for bugs, security problems and unclear code. Use after a significant change or when the user asks for a review.
tools: [Read, Glob, Grep, LS, Bash]
---

You are a careful senior code reviewer. Look for correctness bugs first, then security, then clarity. For each finding
give the file:line, what is wrong, a concrete failing scenario, and a suggested fix. Skip style nitpicks unless asked.
End with a one-line verdict.
`,

  '/agents/planner.md': `---
name: planner
description: Designs an implementation plan for a larger task before any code is written: steps, files to touch, risks.
tools: [Read, Glob, Grep, LS, WebSearch, WebFetch]
---

You are a software architect. Investigate the relevant files, then produce a numbered plan: the approach, each step
with the files it touches, open questions, and risks. Do not write code.
`,

  '/commands/review.md': `---
description: Review the current project or a file for bugs
---
Review $ARGUMENTS (or the whole current project if nothing is named) for correctness bugs, security problems and unclear code. Use the reviewer agent for large projects. Report findings ranked by severity.
`,

  '/commands/explain.md': `---
description: Explain a file, function or concept simply
---
Explain $ARGUMENTS clearly and simply. Start with a one-paragraph summary, then the important details. Use a small example if it helps.
`,

  '/commands/plan.md': `---
description: Make a step-by-step plan before coding
---
Before writing any code, investigate and write a numbered implementation plan for: $ARGUMENTS. List the files you'd change and any questions. Wait for my go-ahead.
`,

  '/tools/word-count/tool.json': JSON.stringify({
    name: 'WordCount',
    description: 'Counts words, lines and characters in a piece of text.',
    input_schema: { type: 'object', properties: { text: { type: 'string', description: 'The text to count' } }, required: ['text'] },
  }, null, 2),
  '/tools/word-count/tool.js': `async function run({ text }) {
  const words = text.trim() ? text.trim().split(/\\s+/).length : 0;
  return { words, lines: text.split('\\n').length, characters: text.length };
}
`,

  '/workspace/welcome/AGENT.md': `# Welcome project

This file is the project memory: the agent reads it whenever you work in this folder. Describe the project, how to
run it and any rules here. Run /init in a project to have the agent write one.
`,
  '/workspace/welcome/index.html': `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Hello</title>
  <style>
    :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: Canvas; }
    h1 { font-size: clamp(2rem, 8vw, 4rem); margin: 0; }
  </style>
</head>
<body>
  <h1>Hello from your phone 👋</h1>
</body>
</html>
`,
  '/knowledge/notes/README.md': `Put files (txt, md, pdf, docx, html, csv, code) in \`docs/\` and tap **Index** in Hub → Knowledge.
The agent searches indexed collections with the KnowledgeSearch tool.
`,
};
