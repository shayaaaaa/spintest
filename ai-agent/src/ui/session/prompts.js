// Inline prompts shown in the transcript: permission requests, questions, plan approval, shortcuts, user-gesture actions.
import { html, useState, useEffect, useRef } from '../../../vendor/preact.mjs';
import { Icon } from '../icons.js';
import { Markdown, DiffView } from '../kit.js';
import { toolSummary } from './transcript.js';
import * as vfs from '../../core/vfs.js';

function Options({ opts, onPick, autoFocus = true }) {
  const [sel, setSel] = useState(0);
  const ref = useRef();
  useEffect(() => {
    if (!autoFocus) return;
    const onKey = (e) => {
      if (['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName) && !document.activeElement.closest('.prompt-box')) return;
      if (e.key === 'ArrowDown') { setSel(s => Math.min(opts.length - 1, s + 1)); e.preventDefault(); }
      else if (e.key === 'ArrowUp') { setSel(s => Math.max(0, s - 1)); e.preventDefault(); }
      else if (e.key === 'Enter' && document.activeElement?.tagName !== 'INPUT') { onPick(opts[sel].value); e.preventDefault(); }
      else if (/^[1-9]$/.test(e.key) && Number(e.key) <= opts.length && document.activeElement?.tagName !== 'INPUT') { onPick(opts[Number(e.key) - 1].value); e.preventDefault(); }
    };
    addEventListener('keydown', onKey);
    ref.current?.scrollIntoView?.({ block: 'nearest' });
    return () => removeEventListener('keydown', onKey);
  }, [sel, opts]);
  return html`<div class="prompt-opts" ref=${ref}>${opts.map((o, i) => html`<button class=${'prompt-opt' + (i === sel ? ' sel' : '')} onPointerEnter=${() => setSel(i)} onClick=${() => onPick(o.value)}><span class="n">${i + 1}.</span><span>${o.label}</span></button>`)}</div>`;
}

function PermissionPrompt({ p }) {
  const [feedback, setFeedback] = useState(null);
  const pv = p.preview;
  const kindTitle = { edit: 'Edit file', exec: p.tool === 'Bash' ? 'Bash command' : 'Run ' + p.tool, network: 'Web access', other: p.tool, read: p.tool }[p.kind] || p.tool;
  const file = pv?.path ? pv.path.split('/').pop() : '';
  const question = p.kind === 'edit' ? (pv?.created ? `Do you want to create ${file}?` : `Do you want to make this edit to ${file || 'the file'}?`) : 'Do you want to proceed?';
  const rule = p.rule || p.tool;
  const opts = [
    { value: 'yes', label: 'Yes' },
    p.kind === 'edit' ? { value: 'acceptEdits', label: 'Yes, and allow all edits during this session' } : { value: 'always', label: `Yes, and don't ask again for ${rule} this session` },
    { value: 'alwaysPersist', label: `Yes, always allow ${rule} (save rule)` },
    { value: 'no', label: 'No, and tell the agent what to do differently' },
  ];
  const pick = (v) => {
    if (v === 'no') { setFeedback(''); return; }
    p.resolve({ choice: v === 'alwaysPersist' ? 'always' : v, persist: v === 'alwaysPersist' });
  };
  return html`<div class="prompt-box">
    <div class="prompt-title"><${Icon} name=${p.kind === 'edit' ? 'edit' : p.kind === 'network' ? 'globe' : 'terminal'} size=${16} />${kindTitle}${p.from === 'subagent' ? html`<span class="tag">subagent</span>` : ''}</div>
    ${pv?.type === 'diff' && html`<div class="dim small" style="margin-bottom:4px">${pv.path}</div><${DiffView} before=${pv.before} after=${pv.after} maxLines=${80} />`}
    ${pv?.type === 'command' && html`<div class="prompt-cmd">${pv.command}</div>${pv.description && html`<div class="dim small" style="margin-top:4px">${pv.description}</div>`}`}
    ${pv?.type === 'code' && html`<div class="prompt-cmd">${pv.code}</div>`}
    ${pv?.type === 'text' && html`<div class="prompt-cmd">${pv.text}</div>`}
    ${!pv && html`<div class="prompt-cmd">${p.tool}(${toolSummary(p.tool, p.input)})</div>`}
    <div class="prompt-q">${question}</div>
    ${feedback === null ? html`<${Options} opts=${opts} onPick=${pick} />` : html`
      <div class="prompt-feedback"><input class="input" autofocus placeholder="What should the agent do instead? (optional)" value=${feedback} onInput=${e => setFeedback(e.target.value)} onKeyDown=${e => e.key === 'Enter' && p.resolve({ choice: 'no', feedback: feedback.trim() })} />
      <button class="btn danger" onClick=${() => p.resolve({ choice: 'no', feedback: feedback.trim() })}>Reject</button></div>`}
  </div>`;
}

function QuestionPrompt({ p }) {
  const [i, setI] = useState(0);
  const [answers, setAnswers] = useState({});
  const [multi, setMulti] = useState([]);
  const [other, setOther] = useState('');
  const q = p.questions[i];
  const next = (ans) => {
    const all = { ...answers, [q.question]: ans };
    setAnswers(all); setMulti([]); setOther('');
    if (i + 1 < p.questions.length) setI(i + 1); else p.resolve({ answers: all });
  };
  return html`<div class="prompt-box">
    <div class="prompt-title"><${Icon} name="info" size=${16} />${q.header || 'Question'} ${p.questions.length > 1 ? html`<span class="dim small">${i + 1}/${p.questions.length}</span>` : ''}</div>
    <div class="prompt-q" style="margin-top:2px">${q.question}</div>
    ${q.multiSelect
      ? html`<div class="prompt-opts">${q.options.map(o => html`<button class=${'prompt-opt' + (multi.includes(o.label) ? ' sel' : '')} onClick=${() => setMulti(m => m.includes(o.label) ? m.filter(x => x !== o.label) : [...m, o.label])}><span class="n">${multi.includes(o.label) ? '☒' : '☐'}</span><span><div>${o.label}</div>${o.description && html`<div class="dim small">${o.description}</div>`}</span></button>`)}</div>
          <button class="btn primary sm" style="margin-top:8px" disabled=${!multi.length && !other} onClick=${() => next(other ? [...multi, other] : multi)}>Submit</button>`
      : html`<${Options} key=${i} opts=${q.options.map(o => ({ value: o.label, label: html`<span><div>${o.label}</div>${o.description && html`<div class="dim small">${o.description}</div>`}</span>` }))} onPick=${next} />`}
    <div class="prompt-feedback"><input class="input" placeholder="Or type your own answer…" value=${other} onInput=${e => setOther(e.target.value)} onKeyDown=${e => e.key === 'Enter' && other.trim() && next(q.multiSelect ? [...multi, other.trim()] : other.trim())} />
      <button class="btn ghost" onClick=${() => p.resolve(null)}>Skip</button></div>
  </div>`;
}

function PlanPrompt({ p }) {
  return html`<div class="prompt-box">
    <div class="prompt-title"><${Icon} name="listChecks" size=${16} />Ready to code?</div>
    <div style="border:1px solid var(--border);border-radius:10px;padding:10px 12px;margin:6px 0 10px;background:var(--bg)"><${Markdown} text=${p.plan} /></div>
    <div class="prompt-q">Would you like to proceed?</div>
    <${Options} opts=${[{ value: 'acceptEdits', label: 'Yes, and auto-accept edits' }, { value: 'ask', label: 'Yes, and manually approve edits' }, { value: 'reject', label: 'No, keep planning' }]} onPick=${(v) => p.resolve(v)} />
  </div>`;
}

function ShortcutPrompt({ p }) {
  const [phase, setPhase] = useState('start');
  const run = () => {
    const back = location.href.split('#')[0].split('?')[0] + '?shortcut-result=1';
    const url = `shortcuts://x-callback-url/run-shortcut?name=${encodeURIComponent(p.name)}&input=text&text=${encodeURIComponent(p.input || '')}&x-success=${encodeURIComponent(back)}`;
    location.href = url;
    setPhase(p.waitForResult ? 'wait' : 'done');
    if (!p.waitForResult) setTimeout(() => p.resolve({ result: null }), 300);
  };
  const paste = async () => { try { p.resolve({ result: await navigator.clipboard.readText() }); } catch { p.resolve({ result: null }); } };
  return html`<div class="prompt-box warn">
    <div class="prompt-title"><${Icon} name="zap" size=${16} />Run shortcut “${p.name}”</div>
    ${p.input && html`<div class="prompt-cmd">${p.input}</div>`}
    ${phase === 'start' && html`<div class="row" style="margin-top:10px"><button class="btn primary" onClick=${run}>Run in Shortcuts</button><button class="btn ghost" onClick=${() => p.resolve(null)}>Cancel</button></div>
      <div class="dim small" style="margin-top:8px">The Shortcuts app opens. To send a result back, end the shortcut with “Copy to Clipboard”, then return here.</div>`}
    ${phase === 'wait' && html`<div class="row wrap" style="margin-top:10px"><button class="btn primary" onClick=${paste}><${Icon} name="copy" />Paste result</button><button class="btn" onClick=${() => p.resolve({ result: null })}>Finished, no result</button><button class="btn ghost" onClick=${() => p.resolve(null)}>Cancel</button></div>`}
  </div>`;
}

function ActionPrompt({ p }) {
  const [err, setErr] = useState(null);
  const go = async () => { try { await p.action(); p.resolve(true); } catch (e) { setErr(String(e.message || e)); } };
  return html`<div class="prompt-box"><div class="prompt-title"><${Icon} name="phone" size=${16} />${p.title}</div>
    ${p.description && html`<div class="prompt-cmd">${p.description}</div>`}
    ${err && html`<div class="err small" style="margin-top:6px">${err}</div>`}
    <div class="row" style="margin-top:10px"><button class="btn primary" onClick=${go}>${p.button || 'Allow'}</button><button class="btn ghost" onClick=${() => p.resolve(false)}>Cancel</button></div></div>`;
}

export function PromptView({ pending }) {
  if (pending.type === 'permission') return html`<${PermissionPrompt} p=${pending} />`;
  if (pending.type === 'question') return html`<${QuestionPrompt} p=${pending} />`;
  if (pending.type === 'plan') return html`<${PlanPrompt} p=${pending} />`;
  if (pending.type === 'shortcut') return html`<${ShortcutPrompt} p=${pending} />`;
  if (pending.type === 'action') return html`<${ActionPrompt} p=${pending} />`;
  return null;
}
