import { app, BrowserWindow, dialog, ipcMain, shell, Menu } from 'electron'
import path from 'node:path'
import { existsSync, writeFileSync } from 'node:fs'
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

function createWindow(options: { show?: boolean } = {}) {
  const config = loadConfig()
  const showWindow = options.show !== false

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
    if (showWindow) mainWindow?.show()
    if (isDev && config.devtools && showWindow) mainWindow?.webContents.openDevTools({ mode: 'detach' })
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

/**
 * 打包产物自检入口：设置 TSD_SMOKE_OUTPUT 时启动隐藏窗口 + 内置后端，
 * 校验渲染进程加载与 /api/health，把结果写入 JSON 后退出。
 * 由 scripts/verify-packaged-app.mjs 与 CI 调用。
 */
async function runPackagedSmoke(outputPath: string): Promise<void> {
  const startedAt = Date.now()
  const result: Record<string, unknown> = { ok: false }
  try {
    const config = loadConfig()
    ensureWorkspace(config.workspace)
    createWindow({ show: false })
    const win = mainWindow
    if (!win) throw new Error('主窗口创建失败')

    const rendererLoaded = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 45_000)
      win.webContents.once('did-finish-load', () => {
        clearTimeout(timer)
        resolve(true)
      })
      win.webContents.once('did-fail-load', (_event, code, description) => {
        clearTimeout(timer)
        console.error('[smoke] renderer failed:', code, description)
        resolve(false)
      })
    })
    if (!rendererLoaded) throw new Error('渲染进程加载失败')

    const renderer = (await win.webContents.executeJavaScript(
      "(() => ({ rootChildren: document.getElementById('root')?.children.length ?? 0, text: (document.body.innerText || '').slice(0, 160) }))()",
      true,
    )) as { rootChildren: number; text: string }
    if (!renderer.rootChildren) throw new Error('渲染进程未挂载根节点')

    const status = await supervisor.start()
    let health: Record<string, unknown> | null = null
    const deadline = Date.now() + 45_000
    while (Date.now() < deadline && status.url) {
      try {
        const response = await fetch(status.url + '/api/health', { signal: AbortSignal.timeout(2000) })
        if (response.ok) {
          health = (await response.json()) as Record<string, unknown>
          break
        }
      } catch {
        /* retry */
      }
      await new Promise((resolve) => setTimeout(resolve, 300))
    }
    if (!health || health.ok !== true) throw new Error('内置后端健康检查失败')

    Object.assign(result, {
      ok: true,
      version: app.getVersion(),
      packaged: app.isPackaged,
      backendUrl: status.url,
      health,
      renderer,
    })
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error)
    result.backend = supervisor.getStatus()
  } finally {
    result.elapsedMs = Date.now() - startedAt
    try {
      writeFileSync(outputPath, JSON.stringify(result, null, 2), 'utf8')
    } catch (error) {
      console.error('[smoke] 写入结果失败', error)
    }
    await supervisor.stop().catch(() => undefined)
    app.exit(result.ok ? 0 : 1)
  }
}

app.whenReady().then(async () => {
  const smokeOutput = process.env.TSD_SMOKE_OUTPUT
  if (smokeOutput) {
    registerIpc()
    await runPackagedSmoke(smokeOutput)
    return
  }

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
