import { app } from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import type { BackendStatus } from '../shared/bridge'
import { ensureWorkspace, loadConfig } from './config'

type StatusListener = (status: BackendStatus) => void

const LOG_LIMIT = 120

export class BackendSupervisor {
  private child: ChildProcess | null = null
  private status: BackendStatus = { state: 'starting', url: '', mode: 'embedded' }
  private listeners = new Set<StatusListener>()
  private logTail: string[] = []
  private stopping = false
  private startAttempts = 0

  onChange(listener: StatusListener) {
    this.listeners.add(listener)
    listener(this.status)
    return () => this.listeners.delete(listener)
  }

  getStatus(): BackendStatus {
    return this.status
  }

  private emit(patch: Partial<BackendStatus>) {
    this.status = { ...this.status, ...patch, logTail: this.logTail.slice(-8) }
    for (const listener of this.listeners) {
      try {
        listener(this.status)
      } catch {
        /* ignore */
      }
    }
  }

  private pushLog(chunk: string) {
    const lines = chunk.split(/\r?\n/).filter((l) => l.trim())
    for (const line of lines) {
      this.logTail.push(line.slice(0, 500))
      if (!app.isPackaged) console.log('[backend]', line)
    }
    if (this.logTail.length > LOG_LIMIT) this.logTail = this.logTail.slice(-LOG_LIMIT)
  }

  /** Candidate interpreter commands, in priority order. */
  private pythonCandidates(): string[] {
    const config = loadConfig()
    const list: string[] = []
    if (process.env.TSD_PYTHON) list.push(process.env.TSD_PYTHON)
    if (config.pythonPath) list.push(config.pythonPath)
    if (process.platform === 'win32') {
      list.push('python.exe', 'python', 'py')
    } else {
      list.push('python3', 'python')
    }
    return list
  }

  /** Locate a bundled backend binary (PyInstaller output) or the dev source tree. */
  private resolveEntry(): { command: string; args: string[]; cwd: string } | null {
    const resources = process.resourcesPath
    const isWin = process.platform === 'win32'
    const exe = isWin ? 'tsd-server.exe' : 'tsd-server'
    const binaryCandidates = [
      path.join(resources, 'backend', 'tsd-server', exe),
      path.join(resources, 'backend', exe),
      path.join(app.getAppPath(), 'backend-dist', 'tsd-server', exe),
      path.join(app.getAppPath(), 'backend-dist', exe),
    ]
    for (const candidate of binaryCandidates) {
      if (existsSync(candidate)) {
        return { command: candidate, args: [], cwd: path.dirname(candidate) }
      }
    }

    const scriptCandidates = [
      path.join(app.getAppPath(), 'server', 'main.py'),
      path.join(resources, 'backend', 'server', 'main.py'),
      path.join(app.getAppPath(), '..', 'server', 'main.py'),
    ]
    for (const script of scriptCandidates) {
      if (existsSync(script)) {
        for (const python of this.pythonCandidates()) {
          return { command: python, args: [script], cwd: path.dirname(script) }
        }
      }
    }
    return null
  }

  private async freePort(): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = net.createServer()
      server.unref()
      server.on('error', reject)
      server.listen(0, '127.0.0.1', () => {
        const address = server.address()
        const port = typeof address === 'object' && address ? address.port : 8791
        server.close(() => resolve(port))
      })
    })
  }

  async start(): Promise<BackendStatus> {
    const config = loadConfig()
    this.stopping = false

    if (config.backendMode === 'external') {
      const url = (config.externalUrl || 'http://127.0.0.1:8791').replace(/\/$/, '')
      this.emit({ state: 'external', url, mode: 'external', message: '使用外部后端' })
      return this.status
    }

    if (this.child) return this.status

    const workspace = ensureWorkspace(config.workspace)
    const entry = this.resolveEntry()
    if (!entry) {
      this.emit({
        state: 'error',
        mode: 'embedded',
        url: '',
        message: '未找到 Python 后端。请安装 Python 3.10+，或在设置中指定解释器路径。',
      })
      return this.status
    }

    const port = await this.freePort()
    const url = `http://127.0.0.1:${port}`
    this.emit({ state: 'starting', mode: 'embedded', url, message: '正在启动 Python 后端…' })

    const args = [...entry.args, '--port', String(port), '--workspace', workspace, '--host', '127.0.0.1']
    try {
      mkdirSync(workspace, { recursive: true })
      // 打包时可以由 scripts/build-installer.mjs 塞入 resources/defaults.json，
      // 让内网部署首次启动就带着网关地址 / 模型名，不用用户手填。
      const bundledDefaults = path.join(process.resourcesPath, 'defaults.json')
      const defaultsEnv = existsSync(bundledDefaults) ? { TSD_DEFAULTS_FILE: bundledDefaults } : {}
      const child = spawn(entry.command, args, {
        cwd: entry.cwd,
        env: {
          ...process.env,
          ...defaultsEnv,
          PYTHONUNBUFFERED: '1',
          PYTHONIOENCODING: 'utf-8',
          TSD_WORKSPACE: workspace,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
      this.child = child
      this.startAttempts = 0
      child.stdout?.on('data', (data: Buffer) => this.pushLog(data.toString()))
      child.stderr?.on('data', (data: Buffer) => this.pushLog(data.toString()))
      child.on('error', (err) => {
        this.emit({ state: 'error', message: `无法启动后端：${err.message}` })
        this.child = null
      })
      child.on('exit', (code, signal) => {
        this.child = null
        if (this.stopping) {
          this.emit({ state: 'offline', message: '后端已停止' })
          return
        }
        if (code !== 0) {
          this.emit({
            state: 'error',
            message: `后端进程已退出（code=${code ?? signal}）`,
          })
          if (this.startAttempts < 1) {
            this.startAttempts += 1
            setTimeout(() => void this.start(), 1200)
          }
        } else {
          this.emit({ state: 'offline', message: '后端已退出' })
        }
      })

      const healthy = await this.waitHealthy(url, 45_000)
      if (healthy) {
        const info = await this.healthInfo(url)
        this.emit({ state: 'online', url, mode: 'embedded', pid: child.pid, version: info?.version, message: '后端已就绪' })
      } else {
        this.emit({ state: 'error', url, mode: 'embedded', message: '后端启动超时，请查看日志或手动重启' })
      }
    } catch (err) {
      this.emit({ state: 'error', message: (err as Error).message })
    }
    return this.status
  }

  private async healthInfo(url: string): Promise<{ version?: string } | null> {
    try {
      const res = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(2500) })
      if (!res.ok) return null
      return (await res.json()) as { version?: string }
    } catch {
      return null
    }
  }

  private async waitHealthy(url: string, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (this.stopping) return false
      try {
        const res = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1500) })
        if (res.ok) return true
      } catch {
        /* retry */
      }
      await new Promise((r) => setTimeout(r, 400))
    }
    return false
  }

  async stop(): Promise<void> {
    this.stopping = true
    const child = this.child
    if (!child) return
    try {
      child.kill(process.platform === 'win32' ? undefined : 'SIGTERM')
    } catch {
      /* ignore */
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        try {
          child.kill('SIGKILL')
        } catch {
          /* ignore */
        }
        resolve()
      }, 2500)
      child.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
    })
    this.child = null
  }

  async restart(): Promise<BackendStatus> {
    await this.stop()
    this.logTail = []
    this.stopping = false
    this.emit({ state: 'starting', message: '正在重启后端…' })
    return this.start()
  }
}
