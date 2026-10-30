import { app } from 'electron'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import type { AppConfig } from '../shared/bridge'

const DEFAULT_CONFIG: Omit<AppConfig, 'workspace'> = {
  backendMode: 'embedded',
  externalUrl: 'http://127.0.0.1:8791',
  pythonPath: '',
  autoStart: true,
  minimizeToTray: false,
  devtools: false,
}

let cache: AppConfig | null = null

function configPath() {
  return path.join(app.getPath('userData'), 'tsd-config.json')
}

export function defaultWorkspace() {
  return path.join(app.getPath('userData'), 'workspace')
}

export function loadConfig(): AppConfig {
  if (cache) return cache
  const base: AppConfig = { ...DEFAULT_CONFIG, workspace: defaultWorkspace() }
  try {
    const file = configPath()
    if (existsSync(file)) {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<AppConfig>
      cache = { ...base, ...parsed, workspace: parsed.workspace || base.workspace }
    } else {
      cache = base
    }
  } catch {
    cache = base
  }
  return cache
}

export function saveConfig(patch: Partial<AppConfig>): AppConfig {
  const next: AppConfig = { ...loadConfig(), ...patch }
  cache = next
  try {
    const dir = path.dirname(configPath())
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    writeFileSync(configPath(), JSON.stringify(next, null, 2), 'utf8')
  } catch (err) {
    console.error('[config] 写入失败', err)
  }
  return next
}

export function ensureWorkspace(workspace: string) {
  try {
    if (!existsSync(workspace)) mkdirSync(workspace, { recursive: true })
  } catch (err) {
    console.error('[config] 创建 workspace 失败', err)
  }
  return workspace
}
