export interface LangInfo {
  label: string
  shiki: string
  color: string
  category: 'code' | 'doc' | 'config' | 'asset' | 'data'
}

const TABLE: Record<string, LangInfo> = {
  ts: { label: 'TS', shiki: 'typescript', color: '#3178c6', category: 'code' },
  tsx: { label: 'TSX', shiki: 'tsx', color: '#3178c6', category: 'code' },
  js: { label: 'JS', shiki: 'javascript', color: '#f7df1e', category: 'code' },
  jsx: { label: 'JSX', shiki: 'jsx', color: '#f7df1e', category: 'code' },
  mjs: { label: 'MJS', shiki: 'javascript', color: '#f7df1e', category: 'code' },
  cjs: { label: 'CJS', shiki: 'javascript', color: '#f7df1e', category: 'code' },
  py: { label: 'PY', shiki: 'python', color: '#4b8bbe', category: 'code' },
  rs: { label: 'RS', shiki: 'rust', color: '#dea584', category: 'code' },
  go: { label: 'GO', shiki: 'go', color: '#00add8', category: 'code' },
  java: { label: 'JAVA', shiki: 'java', color: '#e76f00', category: 'code' },
  kt: { label: 'KT', shiki: 'kotlin', color: '#a97bff', category: 'code' },
  c: { label: 'C', shiki: 'c', color: '#a8b9cc', category: 'code' },
  h: { label: 'H', shiki: 'c', color: '#a8b9cc', category: 'code' },
  cpp: { label: 'C++', shiki: 'cpp', color: '#00599c', category: 'code' },
  hpp: { label: 'H++', shiki: 'cpp', color: '#00599c', category: 'code' },
  cs: { label: 'C#', shiki: 'csharp', color: '#68217a', category: 'code' },
  rb: { label: 'RB', shiki: 'ruby', color: '#cc342d', category: 'code' },
  php: { label: 'PHP', shiki: 'php', color: '#777bb4', category: 'code' },
  swift: { label: 'SW', shiki: 'swift', color: '#f05138', category: 'code' },
  vue: { label: 'VUE', shiki: 'vue', color: '#41b883', category: 'code' },
  svelte: { label: 'SVE', shiki: 'svelte', color: '#ff3e00', category: 'code' },
  html: { label: 'HTML', shiki: 'html', color: '#e34c26', category: 'code' },
  css: { label: 'CSS', shiki: 'css', color: '#563d7c', category: 'code' },
  scss: { label: 'SCSS', shiki: 'scss', color: '#c6538c', category: 'code' },
  less: { label: 'LESS', shiki: 'less', color: '#1d365d', category: 'code' },
  json: { label: 'JSON', shiki: 'json', color: '#cbcb41', category: 'data' },
  jsonc: { label: 'JSON', shiki: 'jsonc', color: '#cbcb41', category: 'data' },
  yaml: { label: 'YML', shiki: 'yaml', color: '#cb171e', category: 'config' },
  yml: { label: 'YML', shiki: 'yaml', color: '#cb171e', category: 'config' },
  toml: { label: 'TOML', shiki: 'toml', color: '#9c4221', category: 'config' },
  ini: { label: 'INI', shiki: 'ini', color: '#6b7280', category: 'config' },
  xml: { label: 'XML', shiki: 'xml', color: '#f1662a', category: 'data' },
  sql: { label: 'SQL', shiki: 'sql', color: '#e38c00', category: 'data' },
  sh: { label: 'SH', shiki: 'bash', color: '#4eaa25', category: 'code' },
  bash: { label: 'BASH', shiki: 'bash', color: '#4eaa25', category: 'code' },
  ps1: { label: 'PS', shiki: 'powershell', color: '#012456', category: 'code' },
  bat: { label: 'BAT', shiki: 'bat', color: '#c1f12e', category: 'code' },
  dockerfile: { label: 'DOCKER', shiki: 'docker', color: '#2496ed', category: 'config' },
  md: { label: 'MD', shiki: 'markdown', color: '#8b949e', category: 'doc' },
  mdx: { label: 'MDX', shiki: 'mdx', color: '#8b949e', category: 'doc' },
  txt: { label: 'TXT', shiki: 'text', color: '#8b949e', category: 'doc' },
  diff: { label: 'DIFF', shiki: 'diff', color: '#8b949e', category: 'doc' },
  lock: { label: 'LOCK', shiki: 'text', color: '#8b949e', category: 'config' },
  png: { label: 'PNG', shiki: 'text', color: '#a855f7', category: 'asset' },
  jpg: { label: 'JPG', shiki: 'text', color: '#a855f7', category: 'asset' },
  jpeg: { label: 'JPG', shiki: 'text', color: '#a855f7', category: 'asset' },
  svg: { label: 'SVG', shiki: 'svg', color: '#ffb13b', category: 'asset' },
  gif: { label: 'GIF', shiki: 'text', color: '#a855f7', category: 'asset' },
  ico: { label: 'ICO', shiki: 'text', color: '#a855f7', category: 'asset' },
  woff2: { label: 'FONT', shiki: 'text', color: '#a855f7', category: 'asset' },
}

const SPECIAL: Record<string, LangInfo> = {
  dockerfile: { label: 'DOCKER', shiki: 'docker', color: '#2496ed', category: 'config' },
  makefile: { label: 'MAKE', shiki: 'makefile', color: '#6d8086', category: 'config' },
  '.gitignore': { label: 'GIT', shiki: 'ini', color: '#f05032', category: 'config' },
  '.env': { label: 'ENV', shiki: 'ini', color: '#ecd53f', category: 'config' },
  'readme.md': { label: 'README', shiki: 'markdown', color: '#8b949e', category: 'doc' },
}

export function extOf(path: string): string {
  const clean = path.split(/[?#]/)[0]
  const base = clean.split('/').pop() || clean
  if (base.includes('.')) return base.split('.').pop()!.toLowerCase()
  return base.toLowerCase()
}

export function langOf(path: string): LangInfo {
  const base = (path.split('/').pop() || '').toLowerCase()
  if (SPECIAL[base]) return SPECIAL[base]
  const ext = extOf(path)
  return TABLE[ext] ?? { label: ext.slice(0, 4).toUpperCase() || 'FILE', shiki: 'text', color: '#8b949e', category: 'code' }
}

const BINARY_EXT = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'bmp', 'tiff', 'psd',
  'zip', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar', 'jar', 'war',
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
  'exe', 'dll', 'so', 'dylib', 'bin', 'class', 'pyc', 'o', 'a',
  'mp3', 'mp4', 'avi', 'mov', 'mkv', 'wav', 'flac', 'ogg', 'woff', 'woff2', 'ttf', 'otf', 'eot',
  'sqlite', 'db', 'lock',
])

export function isBinaryPath(path: string): boolean {
  return BINARY_EXT.has(extOf(path))
}

export function statusMeta(status?: string): { label: string; cls: string; dot: string } {
  switch (status) {
    case 'added':
      return { label: 'A', cls: 'text-[hsl(var(--diff-add))] border-[hsl(var(--diff-add)/0.35)] bg-[hsl(var(--diff-add)/0.12)]', dot: 'bg-[hsl(var(--diff-add))]' }
    case 'deleted':
      return { label: 'D', cls: 'text-[hsl(var(--diff-del))] border-[hsl(var(--diff-del)/0.35)] bg-[hsl(var(--diff-del)/0.12)]', dot: 'bg-[hsl(var(--diff-del))]' }
    case 'renamed':
      return { label: 'R', cls: 'text-[hsl(var(--diff-mod))] border-[hsl(var(--diff-mod)/0.35)] bg-[hsl(var(--diff-mod)/0.12)]', dot: 'bg-[hsl(var(--diff-mod))]' }
    case 'modified':
      return { label: 'M', cls: 'text-[hsl(var(--diff-mod))] border-[hsl(var(--diff-mod)/0.35)] bg-[hsl(var(--diff-mod)/0.12)]', dot: 'bg-[hsl(var(--diff-mod))]' }
    default:
      return { label: '·', cls: 'text-muted-foreground border-border bg-muted', dot: 'bg-muted-foreground/40' }
  }
}
