/**
 * Monaco 运行时装配：语言服务 worker、主题与语言映射。
 * 只在编辑器首次挂载时加载（由 CodeEditor 动态 import），
 * 因此应用启动阶段不承担 Monaco 的体积。
 */
import * as monaco from 'monaco-editor'
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker'
import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker'
import cssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker'
import htmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker'
import tsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker'

self.MonacoEnvironment = {
  getWorker(_workerId: string, label: string) {
    if (label === 'json') return new jsonWorker()
    if (label === 'css' || label === 'scss' || label === 'less') return new cssWorker()
    if (label === 'html' || label === 'handlebars' || label === 'razor') return new htmlWorker()
    if (label === 'typescript' || label === 'javascript') return new tsWorker()
    return new editorWorker()
  },
}

const DARK_THEME = 'tsd-dark'
const LIGHT_THEME = 'tsd-light'

monaco.editor.defineTheme(DARK_THEME, {
  base: 'vs-dark',
  inherit: true,
  rules: [
    { token: 'comment', foreground: '6b7280', fontStyle: 'italic' },
    { token: 'keyword', foreground: 'c084fc' },
    { token: 'string', foreground: '86efac' },
    { token: 'number', foreground: 'fbbf24' },
    { token: 'type', foreground: '7dd3fc' },
    { token: 'function', foreground: 'a5b4fc' },
  ],
  colors: {
    'editor.background': '#0b0d15',
    'editor.foreground': '#e5e9f5',
    'editorLineNumber.foreground': '#3f4658',
    'editorLineNumber.activeForeground': '#8b93a7',
    'editor.selectionBackground': '#7c5cff40',
    'editor.inactiveSelectionBackground': '#7c5cff22',
    'editor.lineHighlightBackground': '#ffffff08',
    'editorCursor.foreground': '#a78bfa',
    'editorIndentGuide.background1': '#ffffff0f',
    'editorWidget.background': '#12151f',
    'editorWidget.border': '#252a38',
    'editorSuggestWidget.background': '#12151f',
    'editorSuggestWidget.selectedBackground': '#7c5cff26',
    'scrollbarSlider.background': '#ffffff14',
    'scrollbarSlider.hoverBackground': '#ffffff24',
    'editorGutter.background': '#0b0d15',
    'editorOverviewRuler.border': '#00000000',
    'diffEditor.insertedTextBackground': '#22c55e22',
    'diffEditor.removedTextBackground': '#ef444426',
    'diffEditor.insertedLineBackground': '#22c55e14',
    'diffEditor.removedLineBackground': '#ef444414',
  },
})

monaco.editor.defineTheme(LIGHT_THEME, {
  base: 'vs',
  inherit: true,
  rules: [{ token: 'comment', foreground: '8a94a6', fontStyle: 'italic' }],
  colors: {
    'editor.background': '#ffffff',
    'editor.foreground': '#1f2430',
    'editorLineNumber.foreground': '#b9c0cd',
    'editor.lineHighlightBackground': '#f4f6fb',
    'editor.selectionBackground': '#0ea5e933',
    'editorWidget.background': '#ffffff',
    'editorWidget.border': '#e2e6ee',
    'diffEditor.insertedLineBackground': '#22c55e12',
    'diffEditor.removedLineBackground': '#ef444412',
  },
})

export const editorTheme = (mode: 'dark' | 'light') => (mode === 'dark' ? DARK_THEME : LIGHT_THEME)

const LANGUAGE_BY_EXT: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  json: 'json',
  jsonc: 'json',
  py: 'python',
  md: 'markdown',
  mdx: 'markdown',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'ini',
  ini: 'ini',
  css: 'css',
  scss: 'scss',
  less: 'less',
  html: 'html',
  xml: 'xml',
  svg: 'xml',
  sh: 'shell',
  bash: 'shell',
  ps1: 'powershell',
  java: 'java',
  go: 'go',
  rs: 'rust',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  hpp: 'cpp',
  cs: 'csharp',
  php: 'php',
  rb: 'ruby',
  kt: 'kotlin',
  swift: 'swift',
  sql: 'sql',
  dockerfile: 'dockerfile',
  vue: 'html',
  svelte: 'html',
  txt: 'plaintext',
}

export function monacoLanguage(path: string): string {
  const base = (path.split('/').pop() || '').toLowerCase()
  if (base === 'dockerfile') return 'dockerfile'
  if (base === 'makefile') return 'makefile'
  const ext = base.includes('.') ? base.split('.').pop()! : ''
  return LANGUAGE_BY_EXT[ext] ?? 'plaintext'
}

export { monaco }
