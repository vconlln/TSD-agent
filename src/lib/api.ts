/**
 * ============================================================================
 * 前端 → 后端的**全部**网络调用都在这个文件里（要加鉴权头/换网关，改这里一处即可）。
 * ============================================================================
 *
 * 契约原则（换后端时只需要对着这几点做）：
 *
 * 1. 所有接口都在同一个 base URL 下，路径固定以 /api/ 开头（见下方 api 对象）。
 * 2. 长任务异步：POST /run 与 /chat 立刻返回 runId，进度只走 SSE
 *    （GET /api/runs/:id/events?since=N），不要用长连接等跑完。
 * 3. 错误：非 2xx + detail 字段说明原因；前端会把 detail 直接当用户可见文案。
 * 4. 时间戳统一毫秒；字段小驼峰（后端可用 Pydantic alias 对齐）。
 *
 * 完整字段表：docs/BACKEND-INTEGRATION.md 的 §3 / §4；类型定义：shared/types.ts。
 * 自检工具：node scripts/contract-check.mjs --api http://你的后端
 *
 * 分组与页面：
 *   健康   GET /api/health                          全局（状态灯 / 启动门禁）
 *   设置   GET|PUT /api/settings                    设置页
 *   项目   GET|POST /api/projects                   工作台 / 项目库
 *          GET|PATCH|DELETE /api/projects/:id
 *   运行   POST /api/projects/:id/run               项目页流水线
 *          GET /api/runs?projectId= /api/runs/:id
 *          POST /api/runs/:id/cancel
 *   对话   POST /api/projects/:id/chat              对话页
 *   文档   GET /api/projects/:id/documents          方案页
 *   差异   GET /api/projects/:id/diff               差异页
 *   代码   GET /api/projects/:id/tree 与 /file      代码页
 *          POST /api/projects/:id/files/write
 *   提案   POST|DELETE /api/projects/:id/apply      对话页「应用到代码」
 *   W3     /api/auth/w3/* 与 GET /api/models        设置页凭证卡
 *   Git    /api/git/repos 与 /api/projects/:id/git/*  仓库页
 *   编辑器 AI  POST /api/projects/:id/agent/edit|explain  代码页
 */
import type {
  AgentEvent,
  AppSettings,
  CreateProjectInput,
  DiffPayload,
  Documents,
  ExplainResult,
  FileContent,
  FileWriteResult,
  GitBranchInfo,
  GitCompareResult,
  GitPublishResult,
  GitReposResult,
  GitStatusInfo,
  HealthInfo,
  InlineEditResult,
  ModelsResult,
  Project,
  Run,
  SettingsPatch,
  StartRunInput,
  TreeNode,
  W3Status,
} from '../../shared/types'

export class ApiError extends Error {
  status: number
  detail?: string
  constructor(message: string, status = 0, detail?: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.detail = detail
  }
}

const DEFAULT_BASE = 'http://127.0.0.1:8791'

/**
 * 后端地址的解析顺序（越靠前优先级越高）：
 *   1. window.tsd.backendUrl      Electron 主进程注入（内置后端 / 打包版）
 *   2. window.__TSD_BOOT__.apiBase 打包时注入
 *   3. VITE_API_BASE              前端开发时直连内网后端（npm run dev:renderer）
 *   4. http://127.0.0.1:8791      默认值
 * 运行时也可以在「设置 → 后端服务」切到外部后端，setApiBase 会覆盖这里的值。
 */
function resolveBase(): string {
  const fromBridge = (window as unknown as { tsd?: { backendUrl?: string } }).tsd?.backendUrl
  const fromBoot = window.__TSD_BOOT__?.apiBase
  const fromEnv = import.meta.env.VITE_API_BASE as string | undefined
  return (fromBridge || fromBoot || fromEnv || DEFAULT_BASE).replace(/\/$/, '')
}

let baseUrl = resolveBase()

export function getApiBase() {
  return baseUrl
}

export function setApiBase(url: string) {
  baseUrl = url.replace(/\/$/, '')
}

async function parseError(res: Response): Promise<ApiError> {
  let detail = ''
  try {
    const text = await res.text()
    try {
      const json = JSON.parse(text)
      detail = json.detail || json.error || text
    } catch {
      detail = text
    }
  } catch {
    /* ignore */
  }
  return new ApiError(detail || `请求失败（HTTP ${res.status}）`, res.status, detail)
}

async function request<T>(path: string, init?: RequestInit & { timeoutMs?: number }): Promise<T> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), init?.timeoutMs ?? 120_000)
  try {
    const res = await fetch(`${baseUrl}${path}`, {
      ...init,
      signal: init?.signal ?? controller.signal,
      headers: {
        'Content-Type': 'application/json',
        ...(init?.headers || {}),
      },
    })
    if (!res.ok) throw await parseError(res)
    if (res.status === 204) return undefined as T
    const ct = res.headers.get('content-type') || ''
    if (!ct.includes('application/json')) return (await res.text()) as unknown as T
    return (await res.json()) as T
  } catch (err) {
    if (err instanceof ApiError) throw err
    if ((err as Error).name === 'AbortError') throw new ApiError('请求超时，请检查后端是否在运行', 0)
    throw new ApiError((err as Error).message || '无法连接后端服务', 0)
  } finally {
    clearTimeout(timeout)
  }
}

/* ------------------------------------------------------------------ */
/* SSE over fetch — POST-free, resumable, works with strict CSP        */
/* ------------------------------------------------------------------ */

export interface StreamHandle {
  close: () => void
  done: Promise<void>
}

function parseSseChunk(buffer: string): { events: string[]; rest: string } {
  const events: string[] = []
  let rest = buffer
  let idx: number
  while ((idx = rest.indexOf('\n\n')) >= 0) {
    const raw = rest.slice(0, idx)
    rest = rest.slice(idx + 2)
    const dataLines = raw
      .split('\n')
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).trimStart())
    if (dataLines.length) events.push(dataLines.join('\n'))
  }
  return { events, rest }
}

/**
 * 消费运行事件流（fetch + ReadableStream，而不是 EventSource：
 * EventSource 不能带 header，也不方便在严格 CSP 下使用）。
 *
 * 后端必须满足三件事：
 *   - seq 在**同一 run 内**单调递增（前端会丢弃 seq <= lastSeq 的事件）；
 *   - 支持 ?since=N：把 seq > N 的历史事件补发一遍（断线重连、刷新页面都靠它）；
 *   - 必须发 run.done 或 run.error 作为终止事件，否则前端会一直等到超时重试。
 */
export function streamRunEvents(
  runId: string,
  opts: {
    since?: number
    onEvent: (event: AgentEvent) => void
    onError?: (err: Error) => void
    onClose?: () => void
  },
): StreamHandle {
  const controller = new AbortController()
  let closed = false
  let lastSeq = opts.since ?? 0

  const done = (async () => {
    let attempt = 0
    while (!closed) {
      try {
        const res = await fetch(`${baseUrl}/api/runs/${runId}/events?since=${lastSeq}`, {
          signal: controller.signal,
          headers: { Accept: 'text/event-stream' },
        })
        if (!res.ok) throw await parseError(res)
        if (!res.body) throw new Error('后端未返回事件流')
        attempt = 0
        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        let finished = false
        while (!closed) {
          const { value, done: readerDone } = await reader.read()
          if (readerDone) break
          buffer += decoder.decode(value, { stream: true })
          const parsed = parseSseChunk(buffer)
          buffer = parsed.rest
          for (const raw of parsed.events) {
            if (raw === '[DONE]') {
              finished = true
              continue
            }
            try {
              const event = JSON.parse(raw) as AgentEvent
              if (event.seq <= lastSeq) continue
              lastSeq = event.seq
              opts.onEvent(event)
              if (event.type === 'run.done' || event.type === 'run.error') finished = true
            } catch {
              /* ignore malformed frame */
            }
          }
          if (finished) break
        }
        if (finished) break
        if (closed) break
        attempt += 1
        if (attempt > 6) break
        await new Promise((r) => setTimeout(r, Math.min(400 * attempt, 2500)))
      } catch (err) {
        if (closed || (err as Error).name === 'AbortError') break
        attempt += 1
        if (attempt > 6) {
          opts.onError?.(err as Error)
          break
        }
        await new Promise((r) => setTimeout(r, Math.min(400 * attempt, 2500)))
      }
    }
    opts.onClose?.()
  })()

  return {
    close: () => {
      closed = true
      controller.abort()
    },
    done,
  }
}

/* ------------------------------------------------------------------ */

export const api = {
  base: () => baseUrl,

  health: () => request<HealthInfo>('/api/health', { timeoutMs: 4000 }),

  getSettings: () => request<AppSettings>('/api/settings'),
  updateSettings: (patch: SettingsPatch) =>
    request<AppSettings>('/api/settings', { method: 'PUT', body: JSON.stringify(patch) }),

  listProjects: () => request<{ projects: Project[] }>('/api/projects'),
  getProject: (id: string) => request<Project>(`/api/projects/${id}`),
  createProject: (input: CreateProjectInput) =>
    request<Project>('/api/projects', { method: 'POST', body: JSON.stringify(input) }),
  updateProject: (id: string, patch: Partial<Project>) =>
    request<Project>(`/api/projects/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  deleteProject: (id: string) => request<void>(`/api/projects/${id}`, { method: 'DELETE' }),

  startRun: (id: string, input: StartRunInput) =>
    request<{ runId: string; run: Run }>(`/api/projects/${id}/run`, { method: 'POST', body: JSON.stringify(input) }),
  startChat: (id: string, message: string, history?: Array<{ role: string; content: string }>) =>
    request<{ runId: string }>(`/api/projects/${id}/chat`, {
      method: 'POST',
      body: JSON.stringify({ message, history: history ?? [] }),
    }),
  cancelRun: (runId: string) => request<{ ok: boolean }>(`/api/runs/${runId}/cancel`, { method: 'POST' }),
  getRun: (runId: string) => request<Run>(`/api/runs/${runId}`),
  listRuns: (projectId: string) => request<{ runs: Run[] }>(`/api/runs?projectId=${projectId}`),

  documents: (id: string) => request<Documents>(`/api/projects/${id}/documents`),
  diff: (id: string, refresh = false) =>
    request<DiffPayload>(`/api/projects/${id}/diff${refresh ? '?refresh=1' : ''}`, { timeoutMs: 60_000 }),
  tree: (id: string, side: 'source' | 'target') =>
    request<{ tree: TreeNode | null; root: string; exists: boolean }>(`/api/projects/${id}/tree?side=${side}`),
  file: (id: string, side: 'source' | 'target', path: string) =>
    request<FileContent>(`/api/projects/${id}/file?side=${side}&path=${encodeURIComponent(path)}`),
  applyProposal: (id: string, proposalId: string) =>
    request<{ ok: boolean; files: string[] }>(`/api/projects/${id}/apply`, {
      method: 'POST',
      body: JSON.stringify({ proposalId }),
    }),
  discardProposal: (id: string, proposalId: string) =>
    request<{ ok: boolean }>(`/api/projects/${id}/apply`, {
      method: 'DELETE',
      body: JSON.stringify({ proposalId }),
    }),
  exportBundle: (id: string) =>
    request<{ ok: boolean; path: string }>(`/api/projects/${id}/export`, { method: 'POST' }),

  /* ---------------------------- W3 auth ---------------------------- */
  w3Status: () => request<W3Status>('/api/auth/w3/status'),
  w3Login: (username: string, password: string) =>
    request<W3Status>('/api/auth/w3/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
      timeoutMs: 45_000,
    }),
  w3Logout: () => request<{ ok: boolean }>('/api/auth/w3/logout', { method: 'POST' }),
  models: () => request<ModelsResult>('/api/models'),

  /* ------------------------------ Git ------------------------------ */
  searchRepos: (prefix: string) =>
    request<GitReposResult>(`/api/git/repos?prefix=${encodeURIComponent(prefix)}`, { timeoutMs: 45_000 }),
  gitClone: (id: string, url: string, branch?: string) =>
    request<{ ok: boolean; branch: string; remote: string; files: number; baseVersion?: string }>(
      `/api/projects/${id}/git/clone`,
      { method: 'POST', body: JSON.stringify({ url, branch }), timeoutMs: 600_000 },
    ),
  gitStatus: (id: string) => request<GitStatusInfo>(`/api/projects/${id}/git/status`),
  gitBranches: (id: string) => request<GitBranchInfo>(`/api/projects/${id}/git/branches`),
  gitCompare: (id: string, base?: string) =>
    request<GitCompareResult>(
      `/api/projects/${id}/git/compare${base ? `?base=${encodeURIComponent(base)}` : ''}`,
      { timeoutMs: 120_000 },
    ),
  gitPublish: (
    id: string,
    body: {
      message: string
      branch?: string
      push?: boolean
      remote?: string
      createBranch?: boolean
      force?: boolean
    },
  ) =>
    request<GitPublishResult>(`/api/projects/${id}/git/publish`, {
      method: 'POST',
      body: JSON.stringify(body),
      timeoutMs: 300_000,
    }),
  gitPush: (id: string, branch: string, remote = 'origin') =>
    request<{ ok: boolean; branch: string; url?: string }>(`/api/projects/${id}/git/push`, {
      method: 'POST',
      body: JSON.stringify({ branch, remote }),
      timeoutMs: 300_000,
    }),

  /* -------------------------- Inline agent -------------------------- */
  agentEdit: (
    id: string,
    body: { path: string; instruction: string; startLine?: number; endLine?: number; content?: string },
  ) =>
    request<InlineEditResult>(`/api/projects/${id}/agent/edit`, {
      method: 'POST',
      body: JSON.stringify(body),
      timeoutMs: 180_000,
    }),
  agentExplain: (
    id: string,
    body: { path: string; startLine?: number; endLine?: number; content?: string; question?: string },
  ) =>
    request<ExplainResult>(`/api/projects/${id}/agent/explain`, {
      method: 'POST',
      body: JSON.stringify(body),
      timeoutMs: 120_000,
    }),
  writeFile: (id: string, path: string, content: string, side: 'source' | 'target' = 'target') =>
    request<FileWriteResult>(`/api/projects/${id}/files/write`, {
      method: 'POST',
      body: JSON.stringify({ path, content, side }),
    }),
}

export { streamRunEvents as subscribeRun }
