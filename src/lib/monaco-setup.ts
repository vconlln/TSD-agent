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

// 主题色全部从 CSS 变量读：切主题时编辑器跟着变，不再是写死的紫色
function tokenTriple(name: string): [number, number, number] | null {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  const parts = raw.split(/\s+/)
  if (parts.length < 3) return null
  const h = parseFloat(parts[0])
  const sat = parseFloat(parts[1])
  const light = parseFloat(parts[2])
  if ([h, sat, light].some((n) => Number.isNaN(n))) return null
  return [h, sat, light]
}

/** Monaco 只认 hex / rgb() / rgba()：把 token 的 HSL 三件套换算过去 */
function hslToRgb(h: number, sat: number, light: number): [number, number, number] {
  const s = sat / 100
  const l = light / 100
  const k = (n: number) => (n + h / 30) % 12
  const a = s * Math.min(l, 1 - l)
  const f = (n: number) => Math.round(255 * (l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))))
  return [f(0), f(8), f(4)]
}

function cssColor(name: string, alpha?: number): string {
  const triple = tokenTriple(name)
  if (!triple) return alpha === undefined ? '#888888' : 'rgba(136, 136, 136, ' + alpha + ')'
  const rgb = hslToRgb(...triple)
  if (alpha === undefined) {
    return '#' + rgb.map((v) => v.toString(16).padStart(2, '0')).join('')
  }
  return 'rgba(' + rgb[0] + ', ' + rgb[1] + ', ' + rgb[2] + ', ' + alpha + ')'
}

/** 语法着色规则只接受 6 位 hex（不带 #） */
function cssHex(name: string): string {
  return cssColor(name).replace('#', '')
}

function defineThemes(): void {
  const ink = cssColor('--foreground')
  monaco.editor.defineTheme(DARK_THEME, {
    base: 'vs-dark',
    inherit: true,
    rules: [
      { token: 'comment', foreground: cssHex('--muted-foreground'), fontStyle: 'italic' },
      { token: 'keyword', foreground: cssHex('--primary') },
      { token: 'string', foreground: cssHex('--success') },
      { token: 'number', foreground: cssHex('--warning') },
      { token: 'type', foreground: cssHex('--info') },
      { token: 'function', foreground: cssHex('--primary') },
    ],
    colors: {
      'editor.background': cssColor('--background'),
      'editor.foreground': ink,
      'editorLineNumber.foreground': cssColor('--muted-foreground', 0.45),
      'editorLineNumber.activeForeground': cssColor('--muted-foreground'),
      'editor.selectionBackground': cssColor('--primary', 0.22),
      'editor.inactiveSelectionBackground': cssColor('--primary', 0.12),
      'editor.lineHighlightBackground': cssColor('--foreground', 0.03),
      'editorCursor.foreground': cssColor('--primary'),
      'editorIndentGuide.background1': cssColor('--border'),
      'editorWidget.background': cssColor('--popover'),
      'editorWidget.border': cssColor('--border'),
      'editorSuggestWidget.background': cssColor('--popover'),
      'editorSuggestWidget.selectedBackground': cssColor('--primary', 0.16),
      'scrollbarSlider.background': cssColor('--foreground', 0.08),
      'scrollbarSlider.hoverBackground': cssColor('--foreground', 0.14),
      'editorGutter.background': cssColor('--background'),
      'editorOverviewRuler.border': cssColor('--border'),
      'diffEditor.insertedTextBackground': cssColor('--diff-add', 0.16),
      'diffEditor.removedTextBackground': cssColor('--diff-del', 0.16),
      'diffEditor.insertedLineBackground': cssColor('--diff-add', 0.09),
      'diffEditor.removedLineBackground': cssColor('--diff-del', 0.09),
    },
  })

  monaco.editor.defineTheme(LIGHT_THEME, {
    base: 'vs',
    inherit: true,
    rules: [
      { token: 'comment', foreground: cssHex('--muted-foreground'), fontStyle: 'italic' },
      { token: 'keyword', foreground: cssHex('--primary') },
      { token: 'string', foreground: cssHex('--success') },
      { token: 'number', foreground: cssHex('--warning') },
    ],
    colors: {
      'editor.background': cssColor('--card'),
      'editor.foreground': ink,
      'editorLineNumber.foreground': cssColor('--muted-foreground', 0.55),
      'editor.lineHighlightBackground': cssColor('--foreground', 0.035),
      'editor.selectionBackground': cssColor('--primary', 0.18),
      'editorWidget.background': cssColor('--popover'),
      'editorWidget.border': cssColor('--border'),
      'diffEditor.insertedLineBackground': cssColor('--diff-add', 0.08),
      'diffEditor.removedLineBackground': cssColor('--diff-del', 0.08),
    },
  })
}

export const editorTheme = (mode: 'dark' | 'light') => {
  defineThemes()
  return mode === 'dark' ? DARK_THEME : LIGHT_THEME
}

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
