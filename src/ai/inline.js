// ⌘K "Edit with AI" inside the editor, and optional AI autocomplete (ghost text).
import { monaco } from '../editor/monaco.js';
import { S, set, saveSettings, command, exec } from '../state.js';
import { h, icon, toast } from '../ui/h.js';
import * as E from '../editor/editors.js';
import { stream, editTarget, usable, providerName, shortModel, SYSTEM_EDIT, SYSTEM_COMPLETE, unfence } from './ai.js';

let session = null; // the one active inline edit

function cleanup(ed) {
  if (!session) return;
  const s = session; session = null;
  s.handle?.abort();
  ed.changeViewZones((a) => { if (s.zone != null) a.removeZone(s.zone); if (s.oldZone != null) a.removeZone(s.oldZone); });
  s.decos?.clear();
  ed.removeContentWidget(s.widget);
  s.keys?.forEach((d) => d.dispose());
  ed.focus();
}

export function inlineEdit() {
  const ed = E.getEditor();
  const path = E.activeFile();
  if (!path || !ed.getModel()) { toast('Open a file to edit with AI'); return; }
  if (session) { session.input?.focus(); return; }
  const tgt = editTarget();
  const p = S.providers.find((x) => x.id === tgt.provider);
  if (!p || !usable(p)) { toast(`Add an API key for ${providerName(tgt.provider)} in Settings → Models`, 'error'); exec('settings.open', 'models'); return; }

  const model = ed.getModel();
  let sel = ed.getSelection();
  // whole lines feel more natural for rewriting
  if (!sel.isEmpty()) sel = new monaco.Selection(sel.startLineNumber, 1, sel.endColumn === 1 && sel.endLineNumber > sel.startLineNumber ? sel.endLineNumber - 1 : sel.endLineNumber, model.getLineMaxColumn(sel.endColumn === 1 && sel.endLineNumber > sel.startLineNumber ? sel.endLineNumber - 1 : sel.endLineNumber));
  const original = model.getValueInRange(sel);

  const input = h('textarea', { class: 'ie-input', rows: 1, placeholder: sel.isEmpty() ? 'Generate code… (e.g. “a debounce helper”)' : 'Edit selection… (e.g. “add error handling”)', spellcheck: 'false' });
  const status = h('span', { class: 'ie-status' }, shortModel(tgt.model));
  const btns = h('div', { class: 'ie-btns' });
  const box = h('div', { class: 'ie-box' }, h('div', { class: 'ie-row' }, icon('wand', 'ie-ic'), input), h('div', { class: 'ie-foot' }, status, btns));
  const dom = h('div', { class: 'ie-widget' }, box);
  const widget = { getId: () => 'kestrel.inline', getDomNode: () => dom, getPosition: () => ({ position: { lineNumber: sel.startLineNumber, column: 1 }, preference: [monaco.editor.ContentWidgetPositionPreference.ABOVE] }) };

  // reserve space above the selection so the widget never covers code
  let zoneId = null;
  ed.changeViewZones((a) => { zoneId = a.addZone({ afterLineNumber: sel.startLineNumber - 1, heightInPx: 92, domNode: h('div'), ordinal: 100000 }); });
  ed.addContentWidget(widget);
  ed.revealLinesInCenterIfOutsideViewport(sel.startLineNumber, sel.endLineNumber);
  session = { widget, zone: zoneId, input, decos: ed.createDecorationsCollection(sel.isEmpty() ? [] : [{ range: sel, options: { className: 'ie-sel', isWholeLine: true } }]) };

  const setButtons = (list) => { btns.replaceChildren(...list.map(([label, kbd, fn, primary]) => h('button', { class: 'btn xs' + (primary ? ' primary' : ''), onclick: fn }, label, kbd ? h('span', { class: 'kbd' }, kbd) : null))); };
  setButtons([['Cancel', 'Esc', () => cleanup(ed)], ['Generate', '↵', () => go(), true]]);
  input.addEventListener('input', () => { input.style.height = 'auto'; input.style.height = Math.min(120, input.scrollHeight) + 'px'; });
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') { e.preventDefault(); cleanup(ed); }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); go(); }
  });
  input.focus();
  requestAnimationFrame(() => input.focus());

  let applied = null; // { range, text }
  async function go() {
    const instruction = input.value.trim();
    if (!instruction || session?.running) return;
    session.running = true;
    input.disabled = true;
    status.replaceChildren(h('span', { class: 'spin' }), ' Generating with ', shortModel(tgt.model), '…');
    setButtons([['Stop', 'Esc', () => cleanup(ed)]]);
    const full = model.getValue();
    const start = model.getOffsetAt(sel.getStartPosition()), end = model.getOffsetAt(sel.getEndPosition());
    const marked = full.slice(0, start) + '<<<SELECTION_START>>>' + full.slice(start, end) + '<<<SELECTION_END>>>' + full.slice(end);
    session.handle = stream({ ...tgt, system: SYSTEM_EDIT, effort: 'low', maxTokens: 16000,
      messages: [{ role: 'user', content: `<file path="${path}" language="${model.getLanguageId()}">\n${marked}\n</file>\n\nInstruction: ${instruction}` }] });
    let out;
    try { out = (await session.handle.promise).text; } catch (e) { if (session) { status.textContent = e.message; status.classList.add('err'); input.disabled = false; session.running = false; setButtons([['Close', 'Esc', () => cleanup(ed)]]); } return; }
    if (!session) return;
    out = unfence(out);
    if (original.endsWith('\n') && !out.endsWith('\n')) out += '\n';
    if (!original.endsWith('\n') && original && out.endsWith('\n')) out = out.replace(/\n+$/, '');
    // apply as an undoable edit, then show what changed: old lines in a red zone, new ones highlighted
    ed.pushUndoStop();
    ed.executeEdits('kestrel-inline', [{ range: sel, text: out, forceMoveMarkers: true }]);
    ed.pushUndoStop();
    const endPos = model.getPositionAt(start + out.length);
    const range = new monaco.Range(sel.startLineNumber, sel.startColumn, endPos.lineNumber, endPos.column);
    applied = { range, text: out };
    session.decos.set(out ? [{ range, options: { className: 'ie-added', isWholeLine: true, linesDecorationsClassName: 'ie-added-gutter' } }] : []);
    if (original) {
      const old = h('div', { class: 'ie-old' }, ...original.replace(/\n$/, '').split('\n').map((l) => h('div', { class: 'ie-old-line' }, l || ' ')));
      old.style.fontSize = set('fontSize') + 'px';
      ed.changeViewZones((a) => { session.oldZone = a.addZone({ ordinal: 0, afterLineNumber: sel.startLineNumber - 1, heightInLines: original.replace(/\n$/, '').split('\n').length, domNode: old }); });
    }
    status.textContent = 'Review the change';
    setButtons([['Reject', 'Esc', reject], ['Accept', '⌘↵', accept, true]]);
    input.disabled = false;
    session.keys = [
      ed.addAction({ id: 'kestrel.ie.accept', label: 'Accept AI edit', keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter], run: accept }),
      ed.addAction({ id: 'kestrel.ie.reject', label: 'Reject AI edit', keybindings: [monaco.KeyCode.Escape], run: reject }),
    ];
    session.running = false;
    ed.focus();
  }
  function accept() { cleanup(ed); }
  function reject() {
    if (applied) { const cur = model.getValueInRange(applied.range); if (cur === applied.text) ed.executeEdits('kestrel-inline', [{ range: applied.range, text: original, forceMoveMarkers: true }]); }
    cleanup(ed);
  }
}

// ---------------- autocomplete ----------------
let provider = null;
export function setupAutocomplete() {
  provider?.dispose();
  provider = null;
  if (!set('autocomplete')) return;
  provider = monaco.languages.registerInlineCompletionsProvider({ pattern: '**' }, {
    async provideInlineCompletions(model, pos, ctx, token) {
      if (!set('autocomplete')) return { items: [] };
      const pid = set('completeProvider'), mid = set('completeModel');
      const p = S.providers.find((x) => x.id === pid);
      if (!p || !usable(p) || !mid) return { items: [] };
      // debounce: wait a beat, bail if the user kept typing
      await new Promise((r) => setTimeout(r, 380));
      if (token.isCancellationRequested) return { items: [] };
      const line = model.getLineContent(pos.lineNumber);
      if (line.slice(pos.column - 1).trim().length > 2) return { items: [] }; // mid-line with code to the right
      const off = model.getOffsetAt(pos), text = model.getValue();
      const prefix = text.slice(Math.max(0, off - 4000), off), suffix = text.slice(off, off + 1500);
      const h2 = stream({ provider: pid, model: mid, system: SYSTEM_COMPLETE, maxTokens: 256, effort: 'low',
        messages: [{ role: 'user', content: `File: ${E.activeFile() || 'untitled'} (${model.getLanguageId()})\n\n${prefix}<CURSOR>${suffix}` }] });
      token.onCancellationRequested(() => h2.abort());
      let out = '';
      try { out = unfence((await h2.promise).text || ''); } catch { return { items: [] }; }
      if (token.isCancellationRequested || !out.trim()) return { items: [] };
      return { items: [{ insertText: out, range: new monaco.Range(pos.lineNumber, pos.column, pos.lineNumber, pos.column) }] };
    },
    disposeInlineCompletions() {},
    freeInlineCompletions() {},
  });
}

command('ai.inlineEdit', 'AI: Edit with AI…', () => inlineEdit());
command('ai.toggleAutocomplete', 'AI: Toggle Autocomplete', async () => {
  await saveSettings({ autocomplete: !set('autocomplete') });
  setupAutocomplete();
  toast(set('autocomplete') ? `AI autocomplete on · ${shortModel(set('completeModel'))}` : 'AI autocomplete off');
});
