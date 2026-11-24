// Monaco setup: web workers (bundled by Vite) and the Kestrel themes.
import EditorWorker from 'monaco-editor/editor/editor.worker.js?worker';
import JsonWorker from 'monaco-editor/language/json/json.worker.js?worker';
import CssWorker from 'monaco-editor/language/css/css.worker.js?worker';
import HtmlWorker from 'monaco-editor/language/html/html.worker.js?worker';
import TsWorker from 'monaco-editor/language/typescript/ts.worker.js?worker';
import * as monaco from 'monaco-editor';

self.MonacoEnvironment = {
  getWorker(_id, label) {
    if (label === 'json') return new JsonWorker();
    if (label === 'css' || label === 'scss' || label === 'less') return new CssWorker();
    if (label === 'html' || label === 'handlebars' || label === 'razor') return new HtmlWorker();
    if (label === 'typescript' || label === 'javascript') return new TsWorker();
    return new EditorWorker();
  },
};

const rules = (c) => [
  { token: '', foreground: c.fg },
  { token: 'comment', foreground: c.comment, fontStyle: 'italic' },
  { token: 'keyword', foreground: c.keyword },
  { token: 'keyword.control', foreground: c.keyword },
  { token: 'storage', foreground: c.keyword },
  { token: 'string', foreground: c.string },
  { token: 'string.escape', foreground: c.number },
  { token: 'regexp', foreground: c.regexp },
  { token: 'number', foreground: c.number },
  { token: 'constant', foreground: c.number },
  { token: 'type', foreground: c.type },
  { token: 'type.identifier', foreground: c.type },
  { token: 'identifier', foreground: c.fg },
  { token: 'variable', foreground: c.fg },
  { token: 'variable.predefined', foreground: c.fn },
  { token: 'predefined', foreground: c.fn },
  { token: 'function', foreground: c.fn },
  { token: 'delimiter', foreground: c.punct },
  { token: 'delimiter.bracket', foreground: c.punct },
  { token: 'operator', foreground: c.op },
  { token: 'tag', foreground: c.tag },
  { token: 'metatag', foreground: c.tag },
  { token: 'attribute.name', foreground: c.type },
  { token: 'attribute.value', foreground: c.string },
  { token: 'key', foreground: c.fn },
  { token: 'string.key.json', foreground: c.fn },
  { token: 'string.value.json', foreground: c.string },
  { token: 'keyword.json', foreground: c.number },
  { token: 'emphasis', fontStyle: 'italic' },
  { token: 'strong', fontStyle: 'bold' },
  { token: 'keyword.md', foreground: c.keyword },
  { token: 'variable.md', foreground: c.fn },
  { token: 'string.link.md', foreground: c.fn },
];

monaco.editor.defineTheme('kestrel-dark', {
  base: 'vs-dark', inherit: true,
  rules: rules({ fg: 'e6e9ef', comment: '5f6b7d', keyword: 'c79bff', string: '9ad79a', number: 'f8b26a', regexp: 'f4a3c0', type: 'ffd479', fn: '7cb4ff', punct: '9aa3b2', op: 'ff9e7a', tag: 'ff7f8a' }),
  colors: {
    'editor.background': '#12141a', 'editor.foreground': '#e6e9ef', 'editorLineNumber.foreground': '#3d4452', 'editorLineNumber.activeForeground': '#c4cad6',
    'editor.lineHighlightBackground': '#181b23', 'editor.lineHighlightBorder': '#00000000', 'editor.selectionBackground': '#ff7a4538', 'editor.inactiveSelectionBackground': '#ff7a4520',
    'editor.selectionHighlightBackground': '#ff7a451f', 'editor.wordHighlightBackground': '#7cb4ff1f', 'editor.findMatchBackground': '#ffb54766', 'editor.findMatchHighlightBackground': '#ffb54730',
    'editorCursor.foreground': '#ff8a50', 'editorIndentGuide.background1': '#1f232c', 'editorIndentGuide.activeBackground1': '#353b48', 'editorWhitespace.foreground': '#2a2f3a',
    'editorBracketMatch.background': '#ff7a4522', 'editorBracketMatch.border': '#ff7a4566', 'editorGutter.background': '#12141a',
    'editorWidget.background': '#181b23', 'editorWidget.border': '#2a2f3a', 'editorSuggestWidget.background': '#181b23', 'editorSuggestWidget.border': '#2a2f3a',
    'editorSuggestWidget.selectedBackground': '#ff7a4526', 'editorHoverWidget.background': '#181b23', 'editorHoverWidget.border': '#2a2f3a',
    'scrollbarSlider.background': '#ffffff12', 'scrollbarSlider.hoverBackground': '#ffffff22', 'scrollbarSlider.activeBackground': '#ffffff30',
    'minimap.background': '#12141a', 'minimapSlider.background': '#ffffff0d', 'editorOverviewRuler.border': '#00000000',
    'diffEditor.insertedTextBackground': '#3fbf7a26', 'diffEditor.removedTextBackground': '#ff5f5f26', 'diffEditor.insertedLineBackground': '#3fbf7a14', 'diffEditor.removedLineBackground': '#ff5f5f14',
    'editorGhostText.foreground': '#6c7486', 'input.background': '#0e1014', 'input.border': '#2a2f3a', 'focusBorder': '#ff7a4588',
    'list.hoverBackground': '#ffffff0a', 'list.activeSelectionBackground': '#ff7a4526', 'list.highlightForeground': '#ffb547', 'editorStickyScroll.background': '#12141a',
    'editorStickyScrollHover.background': '#181b23', 'editorError.foreground': '#ff6b6b', 'editorWarning.foreground': '#ffb547', 'editorInfo.foreground': '#7cb4ff',
  },
});

monaco.editor.defineTheme('kestrel-light', {
  base: 'vs', inherit: true,
  rules: rules({ fg: '1f2430', comment: '8a93a3', keyword: '8a3fd1', string: '2f8a4a', number: 'c2620c', regexp: 'b8366b', type: 'a5690a', fn: '1f63c9', punct: '5c6678', op: 'c4471b', tag: 'c4364a' }),
  colors: {
    'editor.background': '#ffffff', 'editor.foreground': '#1f2430', 'editorLineNumber.foreground': '#b9bfca', 'editorLineNumber.activeForeground': '#3b4252',
    'editor.lineHighlightBackground': '#f5f6f9', 'editor.lineHighlightBorder': '#00000000', 'editor.selectionBackground': '#ff7a4533', 'editor.inactiveSelectionBackground': '#ff7a451c',
    'editorCursor.foreground': '#f05a1a', 'editorIndentGuide.background1': '#eceef2', 'editorIndentGuide.activeBackground1': '#cfd4dd',
    'editorWidget.background': '#ffffff', 'editorWidget.border': '#dde1e8', 'editorSuggestWidget.selectedBackground': '#ff7a451f',
    'diffEditor.insertedTextBackground': '#2fb36a26', 'diffEditor.removedTextBackground': '#e5484d22', 'diffEditor.insertedLineBackground': '#2fb36a12', 'diffEditor.removedLineBackground': '#e5484d10',
    'editorGhostText.foreground': '#a0a7b4', 'focusBorder': '#ff7a4599', 'minimap.background': '#ffffff', 'editorGutter.background': '#ffffff', 'editorStickyScroll.background': '#ffffff',
  },
});

// TypeScript/JavaScript: be lenient — we don't load node_modules typings, so don't flood the gutter with "cannot find module".
for (const d of [monaco.typescript?.typescriptDefaults, monaco.typescript?.javascriptDefaults].filter(Boolean)) {
  d.setDiagnosticsOptions({ noSemanticValidation: true, noSyntaxValidation: false });
  d.setCompilerOptions({ target: 99, module: 99, moduleResolution: 2, allowJs: true, jsx: 4, allowNonTsExtensions: true, esModuleInterop: true });
}

export { monaco };
