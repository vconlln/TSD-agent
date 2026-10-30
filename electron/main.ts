import { app, BrowserWindow, dialog, ipcMain, shell, Menu } from 'electron'
import path from 'node:path'
import { existsSync } from 'node:fs'
import type { AppConfig } from '../shared/bridge'
import { BackendSupervisor } from './backend'
import { loadConfig, saveConfig, ensureWorkspace } from './config'

const isDev = !app.isPackaged || process.env.NODE_ENV === 'development'
const supervisor = new BackendSupervisor()
let mainWindow: BrowserWindow | null = null

app.setName('TSD Agent')
app.setAppUserModelId('com.tsd.agent')

if (!app.requestSingleInstanceLock()) {
  app.quit()
}

function broadcastBackend() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('backend:status', supervisor.getStatus())
  }
}

function createWindow() {
  const config = loadConfig()

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1040,
    minHeight: 680,
    show: false,
    backgroundColor: '#08090f',
    frame: process.platform === 'darwin',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    trafficLightPosition: { x: 16, y: 14 },
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
      webgl: true,
      backgroundThrottling: false,
    },
  })

  Menu.setApplicationMenu(null)

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show()
    if (isDev && config.devtools) mainWindow?.webContents.openDevTools({ mode: 'detach' })
  })

  mainWindow.on('maximize', () => mainWindow?.webContents.send('window:maximize-changed', true))
  mainWindow.on('unmaximize', () => mainWindow?.webContents.send('window:maximize-changed', false))
  mainWindow.on('enter-full-screen', () => mainWindow?.webContents.send('window:maximize-changed', true))
  mainWindow.on('leave-full-screen', () => mainWindow?.webContents.send('window:maximize-changed', false))
  mainWindow.on('closed', () => {
    mainWindow = null
  })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  mainWindow.webContents.on('will-navigate', (event, url) => {
    const current = mainWindow?.webContents.getURL() ?? ''
    if (url !== current && !url.startsWith('devtools://')) {
      event.preventDefault()
      if (/^https?:/i.test(url)) void shell.openExternal(url)
    }
  })

  if (isDev) {
    const devUrl = process.env.VITE_DEV_SERVER_URL ?? 'http://127.0.0.1:5273'
    void mainWindow.loadURL(devUrl)
  } else {
    void mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
}

function registerIpc() {
  ipcMain.handle('backend:status', () => supervisor.getStatus())
  ipcMain.handle('backend:restart', async () => {
    const status = await supervisor.restart()
    broadcastBackend()
    return status
  })

  ipcMain.handle('config:get', () => loadConfig())
  ipcMain.handle('config:set', (_event, patch: Partial<AppConfig>) => {
    const next = saveConfig(patch)
    if (next.workspace) ensureWorkspace(next.workspace)
    return next
  })

  ipcMain.handle('dialog:pick-directory', async (_event, title?: string) => {
    if (!mainWindow) return null
    const result = await dialog.showOpenDialog(mainWindow, {
      title: title || '选择目录',
      properties: ['openDirectory', 'createDirectory'],
    })
    if (result.canceled || !result.filePaths.length) return null
    return result.filePaths[0]
  })

  ipcMain.handle('shell:open-path', async (_event, target: string) => {
    if (!target) return
    if (existsSync(target)) await shell.openPath(target)
  })
  ipcMain.handle('shell:reveal', async (_event, target: string) => {
    if (target && existsSync(target)) shell.showItemInFolder(target)
  })
  ipcMain.handle('shell:open-external', async (_event, url: string) => {
    if (/^https?:/i.test(url)) await shell.openExternal(url)
  })

  ipcMain.on('window:minimize', () => mainWindow?.minimize())
  ipcMain.on('window:toggle-maximize', () => {
    if (!mainWindow) return
    if (mainWindow.isMaximized()) mainWindow.unmaximize()
    else mainWindow.maximize()
  })
  ipcMain.on('window:close', () => mainWindow?.close())
}

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  }
})

app.whenReady().then(async () => {
  registerIpc()
  supervisor.onChange((status) => {
    broadcastBackend()
    if (status.state === 'online') {
      mainWindow?.webContents.send('backend:status', status)
    }
  })

  const config = loadConfig()
  ensureWorkspace(config.workspace)
  createWindow()

  if (config.autoStart) {
    setTimeout(() => {
      void supervisor.start().then(() => broadcastBackend())
    }, 240)
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  void supervisor.stop()
})

process.on('uncaughtException', (err) => {
  console.error('[main] uncaught', err)
})
