// Agent workflow tools: TodoWrite, AskUser, ExitPlanMode, Skill, Task (subagents).
import * as vfs from '../../core/vfs.js';
import { loadMarkdownItems } from '../../core/hub.js';

export const TodoWrite = {
  name: 'TodoWrite',
  description: 'Create or update the task list for the current job. Use it for multi-step work (3+ steps): mark one item in_progress at a time and mark items completed as soon as they are done. Send the full list each time.',
  input_schema: { type: 'object', properties: { todos: { type: 'array', items: { type: 'object', properties: { content: { type: 'string' }, status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] }, activeForm: { type: 'string' } }, required: ['content', 'status'] } } }, required: ['todos'] },
  readOnly: true, kind: 'other',
  summary: (i) => `${i.todos?.length || 0} items`,
  async run({ todos }, ctx) {
    ctx.session.setTodos(todos.map(t => ({ content: String(t.content), status: t.status || 'pending', activeForm: t.activeForm || t.content })));
    return { content: 'Todo list updated. Continue with the current item.', display: { kind: 'todos', todos } };
  },
};

export const AskUser = {
  name: 'AskUser',
  description: 'Ask the user 1–4 multiple-choice questions when you need a decision only they can make. Each question has 2–4 options (label + description); the user can also type their own answer.',
  input_schema: { type: 'object', properties: { questions: { type: 'array', items: { type: 'object', properties: { question: { type: 'string' }, header: { type: 'string' }, multiSelect: { type: 'boolean' }, options: { type: 'array', items: { type: 'object', properties: { label: { type: 'string' }, description: { type: 'string' } }, required: ['label'] } } }, required: ['question', 'options'] } } }, required: ['questions'] },
  readOnly: true, kind: 'other',
  summary: (i) => i.questions?.[0]?.question || '',
  async run({ questions }, ctx) {
    const res = await ctx.askUser(questions);
    if (!res) return { content: 'The user skipped the question. Use your best judgment and say what you assumed.', display: { kind: 'text', text: 'Skipped' } };
    const lines = Object.entries(res.answers).map(([q, a]) => `"${q}" = "${Array.isArray(a) ? a.join(', ') : a}"`);
    return { content: `User answered: ${lines.join('; ')}`, display: { kind: 'answers', answers: res.answers } };
  },
};

export const ExitPlanMode = {
  name: 'ExitPlanMode',
  description: 'In plan mode, present your finished plan (markdown) for the user to approve before you start making changes.',
  input_schema: { type: 'object', properties: { plan: { type: 'string' } }, required: ['plan'] },
  readOnly: true, kind: 'other', planOnly: true,
  summary: () => 'Plan ready for review',
  async run({ plan }, ctx) {
    const decision = await ctx.approvePlan(plan);
    if (decision === 'reject') return { content: 'The user did not approve the plan. Ask what to change, or revise it.', isError: true, display: { kind: 'text', text: 'Plan not approved' } };
    return { content: `The user approved the plan. Permission mode is now "${decision}". Start implementing it, tracking progress with TodoWrite.`, display: { kind: 'plan', plan, decision } };
  },
};

export const Skill = {
  name: 'Skill',
  description: 'Load a skill (reusable instructions from the Hub) by name. Use it when a listed skill matches the task, before doing the task.',
  input_schema: { type: 'object', properties: { skill: { type: 'string' } }, required: ['skill'] },
  readOnly: true, kind: 'read',
  summary: (i) => i.skill,
  async run({ skill }, ctx) {
    const skills = await loadMarkdownItems('skills', ctx.cwd);
    const s = skills.find(x => x.name === skill) || skills.find(x => x.name.toLowerCase() === String(skill).toLowerCase());
    if (!s) throw new Error(`No skill named "${skill}". Available: ${skills.map(x => x.name).join(', ') || 'none'}`);
    const files = (await vfs.list(s.dir).catch(() => [])).filter(e => e.name !== 'SKILL.md').map(e => `${s.dir}/${e.name}${e.kind === 'directory' ? '/' : ''}`);
    return { content: `Skill "${s.name}" (folder ${s.dir}):\n\n${s.body}${files.length ? `\n\nFiles in this skill:\n${files.join('\n')}` : ''}`, display: { kind: 'text', text: `Loaded skill ${s.name}` } };
  },
};

export const Task = {
  name: 'Task',
  description: 'Launch a subagent for a self-contained task (searching across many files, research, a review). It works with its own context and returns a report. Give a complete, standalone prompt. subagent_type is the name of an agent from the list (default "general").',
  input_schema: { type: 'object', properties: { description: { type: 'string', description: '3–5 word summary' }, prompt: { type: 'string' }, subagent_type: { type: 'string' } }, required: ['description', 'prompt'] },
  kind: 'other', readOnly: true,
  summary: (i) => `${i.subagent_type || 'general'}: ${i.description}`,
  async run(input, ctx) {
    const report = await ctx.runSubagent(input);
    return { content: report.text || '(no report)', display: { kind: 'subagent', agent: input.subagent_type || 'general', turns: report.turns, tools: report.tools } };
  },
};

export const coreTools = [TodoWrite, AskUser, ExitPlanMode, Skill, Task];
