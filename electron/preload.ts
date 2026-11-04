import { contextBridge, ipcRenderer } from 'electron'
import type { AppConfig, BackendStatus, FontListResult, TsdBridge } from '../shared/bridge'

const bridge: TsdBridge = {
  platform: process.platform,
  version: process.env.TSD_APP_VERSION ?? '1.0.0',
  isDev: process.env.NODE_ENV === 'development',
  backendUrl: '',

  getBackendStatus: () => ipcRenderer.invoke('backend:status') as Promise<BackendStatus>,
  restartBackend: () => ipcRenderer.invoke('backend:restart') as Promise<BackendStatus>,
  onBackendStatus: (cb) => {
    const listener = (_event: unknown, status: BackendStatus) => {
      bridge.backendUrl = status.url
      cb(status)
    }
    ipcRenderer.on('backend:status', listener)
    return () => ipcRenderer.removeListener('backend:status', listener)
  },

  getConfig: () => ipcRenderer.invoke('config:get') as Promise<AppConfig>,
  setConfig: (patch) => ipcRenderer.invoke('config:set', patch) as Promise<AppConfig>,

  listFonts: (force) => ipcRenderer.invoke('fonts:list', force) as Promise<FontListResult>,
  setZoom: (factor) => ipcRenderer.invoke('window:set-zoom', factor) as Promise<number>,

  pickDirectory: (title) => ipcRenderer.invoke('dialog:pick-directory', title) as Promise<string | null>,
  openPath: (target) => ipcRenderer.invoke('shell:open-path', target) as Promise<void>,
  revealPath: (target) => ipcRenderer.invoke('shell:reveal', target) as Promise<void>,
  openExternal: (url) => ipcRenderer.invoke('shell:open-external', url) as Promise<void>,

  minimize: () => ipcRenderer.send('window:minimize'),
  toggleMaximize: () => ipcRenderer.send('window:toggle-maximize'),
  close: () => ipcRenderer.send('window:close'),
  onMaximizeChange: (cb) => {
    const listener = (_event: unknown, maximized: boolean) => cb(maximized)
    ipcRenderer.on('window:maximize-changed', listener)
    return () => ipcRenderer.removeListener('window:maximize-changed', listener)
  },
}

contextBridge.exposeInMainWorld('tsd', bridge)
