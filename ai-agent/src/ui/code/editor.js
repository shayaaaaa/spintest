// CodeMirror 6 setup: languages, theme-aware highlighting, keymaps, review (merge) view, ghost-text completion.
import * as CM from '../../../vendor/codemirror.mjs';
import { extOf } from '../../core/util.js';

const { EditorView, EditorState, Compartment, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection, dropCursor, rectangularSelection, crosshairCursor,
  history, historyKeymap, defaultKeymap, indentWithTab, foldGutter, foldKeymap, indentOnInput, bracketMatching, syntaxHighlighting, HighlightStyle, tags,
  autocompletion, completionKeymap, closeBrackets, closeBracketsKeymap, searchKeymap, highlightSelectionMatches, StateField, StateEffect, Decoration, WidgetType, ViewPlugin } = CM;

export function languageFor(path) {
  const e = extOf(path);
  switch (e) {
    case 'js': case 'mjs': case 'cjs': return CM.javascript();
    case 'jsx': return CM.javascript({ jsx: true });
    case 'ts': return CM.javascript({ typescript: true });
    case 'tsx': return CM.javascript({ typescript: true, jsx: true });
    case 'py': return CM.python();
    case 'html': case 'htm': case 'svelte': case 'vue': return CM.htmlLang();
    case 'css': case 'scss': return CM.css();
    case 'json': case 'jsonl': case 'webmanifest': return CM.json();
    case 'md': case 'markdown': return CM.markdown();
    case 'c': case 'h': case 'cpp': case 'cc': case 'hpp': return CM.cpp();
    case 'rs': return CM.rust();
    case 'java': case 'kt': return CM.java();
    case 'sql': return CM.sql();
    case 'xml': case 'svg': case 'plist': return CM.xml();
    case 'yml': case 'yaml': return CM.yaml();
    default: return [];
  }
}

const hl = HighlightStyle.define([
  { tag: [tags.keyword, tags.controlKeyword, tags.moduleKeyword, tags.operatorKeyword, tags.definitionKeyword, tags.modifier], color: 'var(--hl-kw, #c792ea)' },
  { tag: [tags.string, tags.special(tags.string), tags.regexp], color: 'var(--hl-str, #a5d6a7)' },
  { tag: [tags.number, tags.bool, tags.null, tags.atom], color: 'var(--hl-num, #f7a76c)' },
  { tag: [tags.comment, tags.lineComment, tags.blockComment], color: 'var(--text-3)', fontStyle: 'italic' },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], color: 'var(--hl-fn, #82aaff)' },
  { tag: [tags.typeName, tags.className, tags.namespace], color: 'var(--hl-type, #4fd6be)' },
  { tag: [tags.propertyName, tags.attributeName], color: 'var(--hl-prop, #ffcb6b)' },
  { tag: [tags.tagName], color: 'var(--hl-tag, #f07178)' },
  { tag: [tags.heading], color: 'var(--accent)', fontWeight: 'bold' },
  { tag: [tags.emphasis], fontStyle: 'italic' }, { tag: [tags.strong], fontWeight: 'bold' },
  { tag: [tags.link, tags.url], color: 'var(--info)', textDecoration: 'underline' },
  { tag: [tags.invalid], color: 'var(--err)' },
  { tag: [tags.operator, tags.punctuation, tags.bracket], color: 'var(--text-2)' },
  { tag: [tags.variableName], color: 'var(--text)' },
]);

// ---- Ghost text (inline AI completion) ----
const setGhost = StateEffect.define();
class GhostWidget extends WidgetType {
  constructor(text) { super(); this.text = text; }
  toDOM() { const s = document.createElement('span'); s.className = 'cm-ghost'; s.textContent = this.text; return s; }
}
const ghostField = StateField.define({
  create: () => ({ text: '', pos: -1 }),
  update(v, tr) {
    for (const e of tr.effects) if (e.is(setGhost)) return e.value;
    if (tr.docChanged || tr.selection) return { text: '', pos: -1 };
    return v;
  },
  provide: (f) => EditorView.decorations.from(f, (v) => v.text && v.pos >= 0 ? Decoration.set([Decoration.widget({ widget: new GhostWidget(v.text), side: 1 }).range(v.pos)]) : Decoration.none),
});

export function ghostCompletion(fetchCompletion, enabled = () => true) {
  let timer = null, ctrl = null;
  const plugin = ViewPlugin.fromClass(class {
    update(u) {
      if (!u.docChanged || !enabled()) return;
      clearTimeout(timer); ctrl?.abort();
      const view = u.view;
      timer = setTimeout(async () => {
        const pos = view.state.selection.main.head;
        const doc = view.state.doc.toString();
        ctrl = new AbortController();
        try {
          const text = await fetchCompletion(doc.slice(Math.max(0, pos - 3000), pos), doc.slice(pos, pos + 1500), ctrl.signal);
          if (text && view.state.selection.main.head === pos) view.dispatch({ effects: setGhost.of({ text, pos }) });
        } catch {}
      }, 700);
    }
    destroy() { clearTimeout(timer); ctrl?.abort(); }
  });
  const accept = keymap.of([{ key: 'Tab', run: (view) => { const g = view.state.field(ghostField, false); if (!g?.text) return false; view.dispatch({ changes: { from: g.pos, insert: g.text }, selection: { anchor: g.pos + g.text.length } }); return true; } },
    { key: 'Escape', run: (view) => { const g = view.state.field(ghostField, false); if (!g?.text) return false; view.dispatch({ effects: setGhost.of({ text: '', pos: -1 }) }); return true; } }]);
  return [ghostField, plugin, CM.Prec ? CM.Prec.highest(accept) : accept];
}

export function createEditor(parent, { doc = '', path = '', onChange, onSave, onSelection, onCmdK, extra = [], readOnly = false, fontSize }) {
  const lang = new Compartment();
  const ro = new Compartment();
  const review = new Compartment();
  const base = [
    lineNumbers(), highlightActiveLineGutter(), foldGutter(), history(), drawSelection(), dropCursor(), EditorState.allowMultipleSelections.of(true),
    indentOnInput(), bracketMatching(), closeBrackets(), autocompletion(), rectangularSelection(), crosshairCursor(), highlightActiveLine(), highlightSelectionMatches(),
    syntaxHighlighting(hl), EditorView.lineWrapping,
    keymap.of([
      { key: 'Mod-s', preventDefault: true, run: () => { onSave?.(); return true; } },
      { key: 'Mod-k', preventDefault: true, run: (v) => { onCmdK?.(v); return true; } },
      ...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, ...foldKeymap, ...completionKeymap, indentWithTab,
    ]),
    ro.of(EditorState.readOnly.of(readOnly)), review.of([]),
    EditorView.updateListener.of((u) => { if (u.docChanged && u.transactions.some(t => !t.annotation(External))) onChange?.(u.state.doc.toString()); if (u.selectionSet) onSelection?.(u.state.selection.main, u.view); }),
    EditorView.theme({ '&': { fontSize: (fontSize || 13.5) + 'px' } }),
    EditorView.contentAttributes.of({ autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false' }),
    ...extra,
  ];
  // One state per open file (keeps undo history); all share the same compartments.
  const stateFor = (d, p) => EditorState.create({ doc: d, extensions: [...base, lang.of(languageFor(p))] });
  const view = new EditorView({ state: stateFor(doc, path), parent });
  view._compartments = { lang, ro, review };
  view._stateFor = stateFor;
  return view;
}

// Marks programmatic edits (agent changes, reverts) so they don't trigger autosave as user edits.
export const External = CM.Annotation.define();
export function replaceDoc(view, text) {
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text }, annotations: External.of(true) });
}

export function setDoc(view, doc, path) {
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: doc }, effects: view._compartments.lang.reconfigure(languageFor(path)) });
}

// Shows a unified diff against `original` (accept/reject chunks) — used to review agent edits and inline edits.
export function setReview(view, original) {
  view.dispatch({ effects: view._compartments.review.reconfigure(original == null ? [] : CM.unifiedMergeView({ original, mergeControls: true, highlightChanges: true, gutter: true })) });
}

export { CM };
