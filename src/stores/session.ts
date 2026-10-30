import { create } from 'zustand'
import type {
  AgentEvent,
  ChatMessage,
  CodeProposal,
  DiffPayload,
  Documents,
  EventLevel,
  FileContent,
  Project,
  Run,
  RunStep,
  Side,
  StartRunInput,
  TreeNode,
} from '../../shared/types'
import { api, ApiError, streamRunEvents, type StreamHandle } from '../lib/api'
import { useProjectsStore } from './projects'

export interface LogLine {
  id: string
  ts: number
  level: EventLevel
  step?: string
  message: string
}

export interface TreeState {
  tree: TreeNode | null
  root: string
  exists: boolean
  loading: boolean
}

export interface ProjectRuntime {
  projectId: string
  runs: Run[]
  activeRunId?: string
  events: AgentEvent[]
  logs: LogLine[]
  chat: ChatMessage[]
  documents?: Documents
  diff?: DiffPayload
  docsLoading: boolean
  diffLoading: boolean
  trees: Partial<Record<Side, TreeState>>
  files: Record<string, FileContent | 'loading' | 'error'>
  error?: string
  hydrated: boolean
}

interface SessionState {
  runtimes: Record<string, ProjectRuntime>
  ensure: (projectId: string) => ProjectRuntime
  hydrate: (projectId: string, project?: Project) => Promise<void>
  refreshProject: (projectId: string) => Promise<void>
  loadDocs: (projectId: string) => Promise<void>
  loadDiff: (projectId: string, refresh?: boolean) => Promise<void>
  loadTree: (projectId: string, side: Side) => Promise<void>
  loadFile: (projectId: string, side: Side, path: string) => Promise<FileContent | undefined>
  startRun: (projectId: string, input: StartRunInput) => Promise<string>
  cancelRun: (projectId: string) => Promise<void>
  sendChat: (projectId: string, message: string) => Promise<void>
  applyProposal: (projectId: string, proposalId: string) => Promise<void>
  discardProposal: (projectId: string, proposalId: string) => void
  clearChat: (projectId: string) => void
  subscribe: (projectId: string, runId: string) => void
  handleEvent: (projectId: string, event: AgentEvent) => void
}

const streams = new Map<string, StreamHandle>()
const runToProject = new Map<string, string>()

const emptyRuntime = (projectId: string): ProjectRuntime => ({
  projectId,
  runs: [],
  events: [],
  logs: [],
  chat: loadChat(projectId),
  docsLoading: false,
  diffLoading: false,
  trees: {},
  files: {},
  hydrated: false,
})

/* ---------------- chat persistence (local, bounded) ---------------- */

const CHAT_KEY = 'tsd.chat.v1'

function loadChat(projectId: string): ChatMessage[] {
  try {
    const raw = localStorage.getItem(`${CHAT_KEY}.${projectId}`)
    if (!raw) return []
    const parsed = JSON.parse(raw) as ChatMessage[]
    return Array.isArray(parsed) ? parsed.map((m) => ({ ...m, streaming: false })) : []
  } catch {
    return []
  }
}

function saveChat(projectId: string, messages: ChatMessage[]) {
  try {
    const trimmed = messages.slice(-120)
    localStorage.setItem(`${CHAT_KEY}.${projectId}`, JSON.stringify(trimmed))
  } catch {
    /* quota */
  }
}

/* ------------------------------------------------------------------ */

function elapsed(run: Run): number {
  return (run.finishedAt ?? Date.now()) - run.startedAt
}

function upsertStep(steps: RunStep[], incoming: Partial<RunStep> & { key: string }): RunStep[] {
  const idx = steps.findIndex((s) => s.key === incoming.key)
  if (idx < 0) {
    return [
      ...steps,
      {
        key: incoming.key,
        title: incoming.title || incoming.key,
        status: incoming.status || 'pending',
        startedAt: incoming.startedAt,
        finishedAt: incoming.finishedAt,
        detail: incoming.detail,
        progress: incoming.progress,
        metrics: incoming.metrics,
      },
    ]
  }
  const next = [...steps]
  next[idx] = { ...next[idx], ...incoming }
  return next
}

export const useSessionStore = create<SessionState>((set, get) => {
  const patchRuntime = (projectId: string, patch: Partial<ProjectRuntime>) => {
    set((state) => {
      const current = state.runtimes[projectId] ?? emptyRuntime(projectId)
      return { runtimes: { ...state.runtimes, [projectId]: { ...current, ...patch } } }
    })
  }

  const mutateRuntime = (projectId: string, fn: (rt: ProjectRuntime) => Partial<ProjectRuntime>) => {
    set((state) => {
      const current = state.runtimes[projectId] ?? emptyRuntime(projectId)
      return { runtimes: { ...state.runtimes, [projectId]: { ...current, ...fn(current) } } }
    })
  }

  return {
    runtimes: {},

    ensure: (projectId) => {
      const existing = get().runtimes[projectId]
      if (existing) return existing
      const runtime = emptyRuntime(projectId)
      set((state) => ({ runtimes: { ...state.runtimes, [projectId]: runtime } }))
      return runtime
    },

    hydrate: async (projectId) => {
      get().ensure(projectId)
      const tasks: Promise<unknown>[] = [get().loadDocs(projectId), get().loadDiff(projectId)]
      try {
        const { runs } = await api.listRuns(projectId)
        patchRuntime(projectId, { runs })
      } catch {
        /* backend may not have runs yet */
      }
      await Promise.allSettled(tasks)
      // resume streaming for a still-running run
      const rt = get().runtimes[projectId]
      const active = rt?.runs?.find((r) => r.status === 'running' || r.status === 'queued')
      if (active) {
        patchRuntime(projectId, { activeRunId: active.id })
        get().subscribe(projectId, active.id)
      }
      patchRuntime(projectId, { hydrated: true })
    },

    refreshProject: async (projectId) => {
      try {
        const project = await api.getProject(projectId)
        useProjectsStore.getState().upsert(project)
      } catch {
        /* ignore */
      }
    },

    loadDocs: async (projectId) => {
      patchRuntime(projectId, { docsLoading: true })
      try {
        const docs = await api.documents(projectId)
        patchRuntime(projectId, { documents: docs, docsLoading: false })
      } catch (err) {
        patchRuntime(projectId, { docsLoading: false, error: (err as Error).message })
      }
    },

    loadDiff: async (projectId, refresh = false) => {
      patchRuntime(projectId, { diffLoading: true })
      try {
        const diff = await api.diff(projectId, refresh)
        patchRuntime(projectId, { diff: diff, diffLoading: false })
      } catch (err) {
        const message = err instanceof ApiError ? err.message : '差异计算失败'
        patchRuntime(projectId, { diffLoading: false })
        if (!String(message).includes('404')) patchRuntime(projectId, { error: message })
      }
    },

    loadTree: async (projectId, side) => {
      mutateRuntime(projectId, (rt) => ({
        trees: { ...rt.trees, [side]: { tree: rt.trees[side]?.tree ?? null, root: rt.trees[side]?.root ?? '', exists: false, loading: true } },
      }))
      try {
        const res = await api.tree(projectId, side)
        mutateRuntime(projectId, (rt) => ({
          trees: { ...rt.trees, [side]: { tree: res.tree, root: res.root, exists: res.exists, loading: false } },
        }))
      } catch {
        mutateRuntime(projectId, (rt) => ({
          trees: { ...rt.trees, [side]: { tree: null, root: '', exists: false, loading: false } },
        }))
      }
    },

    loadFile: async (projectId, side, path) => {
      const key = `${side}:${path}`
      mutateRuntime(projectId, (rt) => ({ files: { ...rt.files, [key]: 'loading' } }))
      try {
        const file = await api.file(projectId, side, path)
        mutateRuntime(projectId, (rt) => ({ files: { ...rt.files, [key]: file } }))
        return file
      } catch {
        mutateRuntime(projectId, (rt) => ({ files: { ...rt.files, [key]: 'error' } }))
        return undefined
      }
    },

    startRun: async (projectId, input) => {
      get().ensure(projectId)
      const { runId, run } = await api.startRun(projectId, input)
      runToProject.set(runId, projectId)
      mutateRuntime(projectId, (rt) => ({
        runs: [run, ...rt.runs.filter((r) => r.id !== run.id)],
        activeRunId: runId,
        events: [],
        logs: [],
      }))
      useProjectsStore.getState().patch(projectId, { status: 'running', targetVersion: input.targetVersion })
      get().subscribe(projectId, runId)
      return runId
    },

    cancelRun: async (projectId) => {
      const rt = get().runtimes[projectId]
      if (!rt?.activeRunId) return
      await api.cancelRun(rt.activeRunId).catch(() => undefined)
    },

    sendChat: async (projectId, message) => {
      const trimmed = message.trim()
      if (!trimmed) return
      get().ensure(projectId)
      const userMessage: ChatMessage = {
        id: `u-${Date.now()}`,
        role: 'user',
        content: trimmed,
        ts: Date.now(),
      }
      mutateRuntime(projectId, (rt) => {
        const chat = [...rt.chat, userMessage]
        saveChat(projectId, chat)
        return { chat }
      })
      try {
        const { runId } = await api.startChat(projectId, trimmed)
        runToProject.set(runId, projectId)
        const assistant: ChatMessage = {
          id: `a-${runId}`,
          role: 'assistant',
          content: '',
          ts: Date.now(),
          runId,
          streaming: true,
        }
        mutateRuntime(projectId, (rt) => {
          const chat = [...rt.chat, assistant]
          saveChat(projectId, chat)
          return { chat }
        })
        get().subscribe(projectId, runId)
      } catch (err) {
        const failed: ChatMessage = {
          id: `e-${Date.now()}`,
          role: 'assistant',
          content: '',
          ts: Date.now(),
          error: err instanceof ApiError ? err.message : '发送失败',
        }
        mutateRuntime(projectId, (rt) => {
          const chat = [...rt.chat, failed]
          saveChat(projectId, chat)
          return { chat }
        })
      }
    },

    applyProposal: async (projectId, proposalId) => {
      await api.applyProposal(projectId, proposalId)
      mutateRuntime(projectId, (rt) => ({
        chat: rt.chat.map((m) =>
          m.proposal?.id === proposalId ? { ...m, proposal: { ...m.proposal, applied: true } } : m,
        ),
      }))
      await get().loadDiff(projectId, true)
      await get().loadDocs(projectId)
      await get().refreshProject(projectId)
      const rt = get().runtimes[projectId]
      if (rt) mutateRuntime(projectId, () => ({ trees: {} , files: {} }))
    },

    discardProposal: (projectId, proposalId) => {
      api.discardProposal(projectId, proposalId).catch(() => undefined)
      mutateRuntime(projectId, (rt) => ({
        chat: rt.chat.map((m) =>
          m.proposal?.id === proposalId ? { ...m, proposal: { ...m.proposal, discarded: true } } : m,
        ),
      }))
    },

    clearChat: (projectId) => {
      mutateRuntime(projectId, () => ({ chat: [] }))
      saveChat(projectId, [])
    },

    subscribe: (projectId, runId) => {
      if (streams.has(runId)) return
      const rt = get().runtimes[projectId]
      const since = rt?.events?.length ? rt.events[rt.events.length - 1].seq : 0
      const handle = streamRunEvents(runId, {
        since,
        onEvent: (event) => {
          runToProject.set(runId, projectId)
          get().handleEvent(projectId, event)
        },
        onError: () => {
          mutateRuntime(projectId, (current) => ({
            runs: current.runs.map((r) =>
              r.id === runId && r.status === 'running'
                ? { ...r, status: 'failed', error: '事件流中断，请检查后端服务', finishedAt: Date.now() }
                : r,
            ),
          }))
        },
        onClose: () => {
          streams.delete(runId)
        },
      })
      streams.set(runId, handle)
    },

    handleEvent: (projectId, event) => {
      runToProject.set(event.runId, projectId)
      mutateRuntime(projectId, (rt) => {
        const events = [...rt.events, event].slice(-4000)
        let logs = rt.logs
        let runs = rt.runs
        let chat = rt.chat

        const patchRun = (fn: (run: Run) => Run) => {
          runs = runs.map((r) => (r.id === event.runId ? fn(r) : r))
        }

        switch (event.type) {
          case 'log': {
            logs = [
              ...logs,
              {
                id: `${event.seq}`,
                ts: event.ts,
                level: event.level || 'info',
                step: event.step,
                message: event.message || '',
              },
            ].slice(-1200)
            break
          }
          case 'step.status': {
            const data = (event.data ?? {}) as Partial<RunStep> & { key?: string }
            patchRun((run) => ({
              ...run,
              steps: upsertStep(run.steps, {
                key: data.key || event.step || 'unknown',
                ...data,
              } as RunStep),
            }))
            break
          }
          case 'run.status': {
            const status = (event.data?.status as Run['status']) || 'running'
            patchRun((run) => ({
              ...run,
              status,
              finishedAt: status === 'running' || status === 'queued' ? run.finishedAt : Date.now(),
            }))
            break
          }
          case 'run.metrics': {
            const data = (event.data ?? {}) as { usage?: Run['usage']; model?: string }
            patchRun((run) => ({ ...run, usage: data.usage ?? run.usage, model: data.model ?? run.model }))
            break
          }
          case 'run.done': {
            const data = (event.data ?? {}) as { summary?: string; status?: Run['status'] }
            patchRun((run) => ({
              ...run,
              status: data.status === 'cancelled' ? 'cancelled' : 'done',
              finishedAt: Date.now(),
              summary: data.summary ?? run.summary,
              steps: run.steps.map((s) => (s.status === 'running' ? { ...s, status: 'done', finishedAt: Date.now() } : s)),
            }))
            useProjectsStore.getState().patch(projectId, { status: 'ready', lastRunId: event.runId })
            break
          }
          case 'run.error': {
            patchRun((run) => ({
              ...run,
              status: 'failed',
              finishedAt: Date.now(),
              error: event.message || (event.data?.message as string) || '执行失败',
              steps: run.steps.map((s) => (s.status === 'running' ? { ...s, status: 'failed', finishedAt: Date.now() } : s)),
            }))
            useProjectsStore.getState().patch(projectId, { status: 'failed', error: event.message })
            break
          }
          case 'chat.delta': {
            const delta = event.delta || (event.data?.delta as string) || ''
            const messageId = `a-${event.runId}`
            chat = chat.map((m) => (m.id === messageId ? { ...m, content: m.content + delta, streaming: true } : m))
            break
          }
          case 'chat.message': {
            const data = (event.data ?? {}) as Partial<ChatMessage> & { replacedContent?: boolean }
            const messageId = `a-${event.runId}`
            chat = chat.map((m) =>
              m.id === messageId
                ? {
                    ...m,
                    content: data.content ?? m.content,
                    streaming: false,
                    thinking: data.thinking ?? m.thinking,
                    proposal: (data.proposal as CodeProposal) ?? m.proposal,
                    error: data.error,
                  }
                : m,
            )
            if (!chat.some((m) => m.id === messageId)) {
              chat = [
                ...chat,
                {
                  id: messageId,
                  role: 'assistant',
                  content: data.content ?? '',
                  ts: event.ts,
                  runId: event.runId,
                  proposal: data.proposal as CodeProposal | undefined,
                },
              ]
            }
            saveChat(projectId, chat)
            break
          }
          case 'chat.proposal': {
            const proposal = (event.data ?? {}) as unknown as CodeProposal
            const messageId = `a-${event.runId}`
            chat = chat.map((m) => (m.id === messageId ? { ...m, proposal } : m))
            saveChat(projectId, chat)
            break
          }
          default:
            break
        }

        return { events, logs, runs, chat }
      })

      if (event.type === 'run.done' || event.type === 'run.error') {
        get().loadDocs(projectId)
        get().loadDiff(projectId, true)
        get().refreshProject(projectId)
      }
      if (event.type === 'step.status' && (event.data as { key?: string })?.key === 'download') {
        get().loadTree(projectId, 'source')
      }
      if (event.type === 'run.done') {
        mutateRuntime(projectId, () => ({ trees: {}, files: {} }))
        get().loadTree(projectId, 'target')
      }
    },
  }
})

export function currentRun(rt: ProjectRuntime | undefined): Run | undefined {
  if (!rt) return undefined
  if (rt.activeRunId) {
    const active = rt.runs.find((r) => r.id === rt.activeRunId && isRunActive(r))
    if (active) return active
    const found = rt.runs.find((r) => r.id === rt.activeRunId)
    if (found && found.kind === 'upgrade') return found
  }
  // Pipeline view always reflects the newest upgrade run; chat runs live in the chat tab.
  return rt.runs.find((r) => r.kind === 'upgrade') ?? rt.runs.find((r) => isRunActive(r)) ?? rt.runs[0]
}

export function isRunActive(run?: Run): boolean {
  return run?.status === 'running' || run?.status === 'queued'
}

export { elapsed }
