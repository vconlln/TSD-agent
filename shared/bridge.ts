/** Context-bridge surface exposed by electron/preload.ts as window.tsd. */

export type BackendMode = 'embedded' | 'external'

export interface BackendStatus {
  state: 'starting' | 'online' | 'offline' | 'error' | 'external'
  url: string
  mode: BackendMode
  pid?: number
  version?: string
  message?: string
  logTail?: string[]
}

export interface AppConfig {
  backendMode: BackendMode
  externalUrl: string
  pythonPath?: string
  workspace: string
  autoStart: boolean
  minimizeToTray: boolean
  devtools: boolean
}

export interface TsdBridge {
  platform: string
  version: string
  isDev: boolean
  backendUrl: string
  getBackendStatus: () => Promise<BackendStatus>
  restartBackend: () => Promise<BackendStatus>
  onBackendStatus: (cb: (status: BackendStatus) => void) => () => void
  getConfig: () => Promise<AppConfig>
  setConfig: (patch: Partial<AppConfig>) => Promise<AppConfig>
  pickDirectory: (title?: string) => Promise<string | null>
  openPath: (path: string) => Promise<void>
  revealPath: (path: string) => Promise<void>
  openExternal: (url: string) => Promise<void>
  minimize: () => void
  toggleMaximize: () => void
  close: () => void
  onMaximizeChange: (cb: (maximized: boolean) => void) => () => void
}
