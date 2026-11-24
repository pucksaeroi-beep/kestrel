// Renderer-side AI helpers: streaming requests, provider/model lists, shared prompts.
import { S, set, emit } from '../state.js';
import { uid } from '../ui/h.js';

const listeners = new Map();
window.ks.ai.onDelta((id, t) => listeners.get(id)?.(t));

/** Stream a chat completion. Returns { promise, abort }. onText(fullTextSoFar, delta). */
export function stream({ provider, model, system, messages, maxTokens, effort }, onText) {
  const id = uid('r');
  let full = '';
  listeners.set(id, (t) => { full += t; onText?.(full, t); });
  const promise = window.ks.ai.chat(id, { provider, model, system, messages, maxTokens, effort })
    .then((r) => ({ ...r, text: r.text ?? full }))
    .finally(() => listeners.delete(id));
  return { id, promise, abort: () => window.ks.ai.abort(id) };
}

export async function loadProviders() {
  S.providers = await window.ks.ai.providers();
  emit('providers');
  return S.providers;
}
export const usable = (p) => p.hasKey || p.noKey || (p.optionalKey && p.baseURL);
export const providerName = (id) => S.providers.find((p) => p.id === id)?.name || id;

export const chatTarget = () => ({ provider: set('chatProvider'), model: set('chatModel') });
export const editTarget = () => (set('editProvider') && set('editModel') ? { provider: set('editProvider'), model: set('editModel') } : chatTarget());

export function shortModel(m = '') {
  return m.replace(/^models\//, '').replace(/^claude-/, 'Claude ').replace(/^(Claude \w+)-(\d+)-(\d+)$/, '$1 $2.$3').replace(/^(Claude \w+)-(\d+)$/, '$1 $2')
    .replace(/^Claude (\w)/, (_m, c) => 'Claude ' + c.toUpperCase());
}

export const SYSTEM_CHAT = `You are Kestrel, an expert pair-programmer built into the Kestrel code editor on macOS.
The user's open workspace, current file and selection may be attached as <file> and <selection> blocks — treat them as the ground truth for the code.
Answer concisely and precisely. Prefer showing code over describing it.
When you propose a change to a file, put the code in a fenced block whose info string is the language followed by the workspace-relative path, e.g. \`\`\`ts src/app.ts — the user can click "Apply" to review it as a diff.
For small edits you may show only the changed region with enough surrounding lines to locate it; for new files show the whole file.
Never invent file contents you have not seen; ask for the file instead.`;

export const SYSTEM_APPLY = `You merge a proposed code change into a file.
You receive the current file and an edit snippet that may be partial (it can omit unchanged code or use comments like "// ... existing code ...").
Output the COMPLETE updated file and nothing else: no explanations, no Markdown fences. Keep every line the edit does not touch exactly as it was.`;

export const SYSTEM_EDIT = `You rewrite a selected region of code according to an instruction.
You receive the file with the selection marked between <<<SELECTION_START>>> and <<<SELECTION_END>>>, and the instruction.
Output ONLY the replacement text for the selection — no explanations, no Markdown fences, no markers. Match the file's indentation and style.
If the selection is empty, output the code to insert at that position.`;

export const SYSTEM_COMPLETE = `You are a code completion engine. Continue the code at <CURSOR>.
Output ONLY the text to insert at the cursor — no explanations, no Markdown fences, no repetition of the text before or after the cursor.
Keep it short: finish the current statement or block (at most ~8 lines). If nothing sensible should be inserted, output nothing.`;

/** Strip one surrounding ``` fence if a model added it anyway. */
export function unfence(t) {
  const m = /^\s*```[^\n]*\n([\s\S]*?)\n?```\s*$/.exec(t);
  return m ? m[1] : t;
}
