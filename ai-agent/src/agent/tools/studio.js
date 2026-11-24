// Studio tools: Models (list/download/select), Dataset (build training data), Train (start/monitor training runs).
import * as vfs from '../../core/vfs.js';
import { settings } from '../../core/settings.js';
import { fmtBytes } from '../../core/util.js';

export const Models = {
  name: 'Models',
  description: 'Manage AI models. action "list" (downloaded + available cloud models), "catalog" (recommended downloads), "download" (by catalog name, or repo + file for any GGUF on Hugging Face, or repo for safetensors training bases), "use" (set the model for agent|chat|code|complete).',
  input_schema: { type: 'object', properties: { action: { type: 'string', enum: ['list', 'catalog', 'download', 'use'] }, name: { type: 'string' }, repo: { type: 'string' }, file: { type: 'string' }, role: { type: 'string' }, ref: { type: 'string' } }, required: ['action'] },
  kind: 'other',
  summary: (i) => `${i.action} ${i.name || i.repo || i.ref || ''}`,
  async run(i) {
    const reg = await import('../../models/registry.js');
    const cat = await import('../../models/catalog.js');
    if (i.action === 'list') {
      await reg.refreshModels();
      const local = reg.modelsStore.get().local.map(m => `• ${m.name} [${m.kind}/${m.engine}] ${m.status}${m.bytes ? ' · ' + fmtBytes(m.bytes) : ''} — ref ${m.ref}`);
      const chat = reg.chatModels().filter(m => !m.local).map(m => `• ${m.label} (${m.sub}) — ref ${m.ref}`);
      return `On-device:\n${local.join('\n') || '(none)'}\n\nCloud:\n${chat.join('\n') || '(no API keys added)'}\n\nCurrent: agent=${reg.modelFor('agent')}, chat=${reg.modelFor('chat')}`;
    }
    if (i.action === 'catalog') return [...cat.GGUF_CATALOG.map(m => `• ${m.name} — ${m.sizeGB} GB — ${m.blurb}`), '', 'Training bases:', ...cat.TRAIN_CATALOG.map(m => `• ${m.name} (${m.repo}) — ${m.blurb}`)].join('\n');
    if (i.action === 'download') {
      const g = cat.GGUF_CATALOG.find(m => m.name.toLowerCase() === String(i.name || '').toLowerCase() || (i.repo && m.repo === i.repo && (!i.file || m.file === i.file)));
      if (g) { await reg.installGGUF(g); return `Downloading ${g.name} (${g.sizeGB} GB). Progress shows in Studio → Models.`; }
      const t = cat.TRAIN_CATALOG.find(m => m.name.toLowerCase() === String(i.name || '').toLowerCase() || m.repo === i.repo);
      if (t) { await reg.installSafetensors(t); return `Downloading training base ${t.name}.`; }
      if (i.repo && i.file) { await reg.installGGUF({ repo: i.repo, file: i.file, name: i.name }); return `Downloading ${i.repo}/${i.file}.`; }
      if (i.repo) { await reg.installSafetensors({ repo: i.repo, name: i.name }); return `Downloading ${i.repo} (safetensors).`; }
      throw new Error('Give a catalog name, or repo (+ file for GGUF).');
    }
    if (i.action === 'use') {
      const role = i.role || 'agent';
      const m = reg.chatModels().find(x => x.ref === i.ref || x.label.toLowerCase().includes(String(i.name || i.ref || '').toLowerCase()));
      if (!m) throw new Error('Model not found. Use action "list".');
      settings.set(s => ({ ...s, models: { ...s.models, [role]: m.ref } }));
      return `${role} model set to ${m.label}.`;
    }
  },
};

export const Dataset = {
  name: 'Dataset',
  description: 'Build training datasets in ~/datasets/<name>/data.jsonl. action "create" (type sft|dpo|grpo|text, optional rows), "append" (rows), "inspect" (count + samples + checks), "from_chats" (turn saved conversations into SFT rows), "split" (train/validation). SFT rows: {"messages":[{"role":"user","content":…},{"role":"assistant","content":…}]}. DPO: {"prompt","chosen","rejected"}. GRPO: {"prompt","answer"}. text: {"text"}.',
  input_schema: { type: 'object', properties: { action: { type: 'string', enum: ['create', 'append', 'inspect', 'from_chats', 'split'] }, name: { type: 'string' }, type: { type: 'string', enum: ['sft', 'dpo', 'grpo', 'text'] }, rows: { type: 'array', items: { type: 'object' } }, description: { type: 'string' }, validation: { type: 'number' } }, required: ['action', 'name'] },
  kind: 'edit',
  key: (i) => i.name,
  summary: (i) => `${i.action} ${i.name}`,
  async run(i) {
    const ds = await import('../../studio/datasets.js');
    if (i.action === 'create') { const r = await ds.createDataset(i.name, { type: i.type || 'sft', description: i.description, rows: i.rows || [] }); return `Created dataset ${r.dir} with ${r.count} rows.`; }
    if (i.action === 'append') { const n = await ds.appendRows(i.name, i.rows || []); return `Appended ${i.rows?.length || 0} rows (total ${n}).`; }
    if (i.action === 'inspect') { const r = await ds.inspect(i.name); return JSON.stringify(r, null, 2); }
    if (i.action === 'from_chats') { const n = await ds.fromChats(i.name); return `Added ${n} conversation rows from saved chats.`; }
    if (i.action === 'split') { const r = await ds.split(i.name, i.validation || 0.1); return `Split into ${r.train} train / ${r.val} validation rows.`; }
  },
};

export const Train = {
  name: 'Train',
  description: 'Start or check a training run on this phone (Forge engine, WebGPU). action "estimate" (memory/time for a config), "start" (method sft|lora|qlora|pretrain|dpo|grpo with base model ref or "scratch", dataset name and hyperparameters), "status", "stop". For big jobs suggest Offload (Colab/HF Jobs/RunPod) in Studio.',
  input_schema: { type: 'object', properties: {
    action: { type: 'string', enum: ['estimate', 'start', 'status', 'stop'] },
    method: { type: 'string', enum: ['sft', 'lora', 'qlora', 'pretrain', 'dpo', 'grpo'] },
    base: { type: 'string', description: 'Model ref (local:llm/…) of a safetensors model, or "scratch"' },
    dataset: { type: 'string' }, name: { type: 'string' },
    epochs: { type: 'number' }, lr: { type: 'number' }, rank: { type: 'number' }, alpha: { type: 'number' }, seqLen: { type: 'number' }, batch: { type: 'number' }, gradAccum: { type: 'number' },
    size: { type: 'string', description: 'For pretrain from scratch: nano|micro|small|base' }, reward: { type: 'string', description: 'GRPO reward: exact|contains|regex|numeric|length or JS code' },
    run: { type: 'string' },
  }, required: ['action'] },
  kind: 'exec',
  key: (i) => i.method || i.action,
  summary: (i) => `${i.action}${i.method ? ' ' + i.method : ''}${i.dataset ? ' on ' + i.dataset : ''}`,
  async run(i) {
    const jobs = await import('../../forge/jobs.js');
    if (i.action === 'estimate') return JSON.stringify(await jobs.estimate(i), null, 2);
    if (i.action === 'start') { const r = await jobs.startRun(i); return `Started run ${r.id} (${r.method}). Watch it in Studio → Train. Checkpoints save to ${r.dir}.`; }
    if (i.action === 'status') return JSON.stringify(await jobs.status(i.run), null, 2);
    if (i.action === 'stop') { await jobs.stopRun(i.run); return 'Stopped (checkpoint saved).'; }
  },
};

export const studioTools = [Models, Dataset, Train];
