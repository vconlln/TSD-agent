import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readdirSync } from 'node:fs'
import path from 'node:path'

const run = promisify(execFile)

export interface FontListResult {
  families: string[]
  source: string
  truncated: boolean
}

let cache: { at: number; value: FontListResult } | null = null
const CACHE_MS = 60_000
const LIMIT = 600

/** 去掉 "Arial (TrueType)" 之类的后缀，只留族名 */
function cleanFamily(raw: string): string {
  return raw
    .replace(/\\-/g, '-')
    .replace(/\\,/g, ',')
    .replace(/\s*\((TrueType|OpenType|PostScript|Type 1|Vector|Raster|Bitmap)\)\s*$/i, '')
    .replace(/\s*\(.*?\)\s*$/, '')
    .replace(/[\u0000-\u001f]/g, '')
    .trim()
}

function dedupe(list: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const item of list) {
    const family = cleanFamily(item)
    if (!family) continue
    const key = family.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(family)
  }
  return out.sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'))
}

async function readWindows(): Promise<string[]> {
  const roots = [
    'HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts',
    'HKCU\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts',
  ]
  const names: string[] = []
  for (const root of roots) {
    try {
      const { stdout } = await run('reg', ['query', root], { timeout: 8000, windowsHide: true })
      for (const line of stdout.split(/\r?\n/)) {
        const match = /^\s{2,}(.+?)\s{4,}REG_SZ/.exec(line)
        if (match) names.push(match[1])
      }
    } catch {
      /* 注册表读不到就退回文件列表 */
    }
  }
  if (names.length) return names

  // 兜底：直接看字体目录里的文件名（.ttf / .otf / .ttc）
  const dir = path.join(process.env.WINDIR || 'C:\\Windows', 'Fonts')
  try {
    return readdirSync(dir)
      .filter((file) => /\.(ttf|otf|ttc)$/i.test(file))
      .map((file) => file.replace(/\.[^.]+$/, '').replace(/[-_]/g, ' '))
  } catch {
    return []
  }
}

async function readFcList(): Promise<string[]> {
  // %{family[0]} 每个字体只取首选族名，比 ": family" 干净得多（不含字重变体）
  const { stdout } = await run('fc-list', ['--format', '%{family[0]}\n'], {
    timeout: 10000,
    maxBuffer: 16 * 1024 * 1024,
  })
  return stdout
    .split(/\r?\n/)
    .map((line) => line.replace(/\\-/g, '-').replace(/\\,/g, ',').trim())
    .filter(Boolean)
}

async function readMacDirFonts(): Promise<string[]> {
  const dirs = ['/System/Library/Fonts', '/Library/Fonts', path.join(process.env.HOME ?? '', 'Library/Fonts')]
  const names: string[] = []
  for (const dir of dirs) {
    try {
      for (const file of readdirSync(dir)) {
        if (/\.(ttf|otf|ttc)$/i.test(file)) {
          names.push(file.replace(/\.[^.]+$/, '').replace(/[-_]/g, ' '))
        }
      }
    } catch {
      /* 目录不存在就跳过 */
    }
  }
  return names
}

/**
 * 扫描本机已安装字体族。
 * Windows 读注册表（最准），macOS 先试 fc-list 再看字体目录，Linux 用 fc-list。
 */
export async function listSystemFonts(force = false): Promise<FontListResult> {
  if (!force && cache && Date.now() - cache.at < CACHE_MS) return cache.value

  let families: string[] = []
  let source = 'unknown'
  try {
    if (process.platform === 'win32') {
      families = await readWindows()
      source = 'windows-registry'
    } else if (process.platform === 'darwin') {
      try {
        families = await readFcList()
        source = 'fontconfig'
      } catch {
        families = await readMacDirFonts()
        source = 'fonts-directory'
      }
    } else {
      try {
        families = await readFcList()
        source = 'fontconfig'
      } catch {
        families = await readMacDirFonts()
        source = 'fonts-directory'
      }
    }
  } catch {
    families = []
  }

  const unique = dedupe(families)
  const value: FontListResult = {
    families: unique.slice(0, LIMIT),
    source,
    truncated: unique.length > LIMIT,
  }
  cache = { at: Date.now(), value }
  return value
}
