import { create } from 'zustand'
import type { GitBranchInfo, GitCompareResult, GitStatusInfo } from '../../shared/types'
import { api, ApiError } from '../lib/api'

export interface GitRuntime {
  status?: GitStatusInfo
  branches?: GitBranchInfo
  compare?: GitCompareResult
  loading: boolean
  loadingCompare: boolean
  error?: string
  lastAction?: { kind: 'clone' | 'publish' | 'push'; at: number; ok: boolean; message: string }
}

interface GitState {
  runtimes: Record<string, GitRuntime>
  refresh: (projectId: string) => Promise<void>
  clone: (projectId: string, url: string, branch?: string) => Promise<void>
  publish: (
    projectId: string,
    body: {
      message: string
      branch?: string
      push?: boolean
      remote?: string
      createBranch?: boolean
      force?: boolean
    },
  ) => Promise<{ ok: boolean; note?: string; url?: string }>
  compare: (projectId: string, base?: string) => Promise<void>
  clear: (projectId: string) => void
}

const empty = (): GitRuntime => ({ loading: false, loadingCompare: false })

export const useGitStore = create<GitState>((set, get) => {
  const patch = (projectId: string, next: Partial<GitRuntime>) => {
    set((state) => ({
      runtimes: { ...state.runtimes, [projectId]: { ...(state.runtimes[projectId] ?? empty()), ...next } },
    }))
  }

  return {
    runtimes: {},

    refresh: async (projectId) => {
      patch(projectId, { loading: true, error: undefined })
      try {
        const status = await api.gitStatus(projectId)
        patch(projectId, { status, loading: false })
        if (status.initialized) {
          const [branches, compare] = await Promise.all([
            api.gitBranches(projectId).catch(() => undefined),
            api.gitCompare(projectId).catch(() => undefined),
          ])
          patch(projectId, { branches, compare })
        }
      } catch (err) {
        patch(projectId, {
          loading: false,
          error: err instanceof ApiError ? err.message : 'Git 状态读取失败',
        })
      }
    },

    compare: async (projectId, base) => {
      patch(projectId, { loadingCompare: true })
      try {
        const compare = await api.gitCompare(projectId, base)
        patch(projectId, { compare, loadingCompare: false })
      } catch (err) {
        patch(projectId, {
          loadingCompare: false,
          error: err instanceof ApiError ? err.message : '对比失败',
        })
      }
    },

    clone: async (projectId, url, branch) => {
      patch(projectId, { loading: true, error: undefined })
      try {
        const result = await api.gitClone(projectId, url, branch)
        patch(projectId, {
          loading: false,
          lastAction: {
            kind: 'clone',
            at: Date.now(),
            ok: true,
            message: `已克隆 ${result.files} 个文件到 ${result.branch || '默认分支'}`,
          },
        })
        await get().refresh(projectId)
      } catch (err) {
        const message = err instanceof ApiError ? err.message : '克隆失败'
        patch(projectId, { loading: false, error: message })
        throw err
      }
    },

    publish: async (projectId, body) => {
      patch(projectId, { loading: true, error: undefined })
      try {
        const result = await api.gitPublish(projectId, body)
        const message = result.ok
          ? result.pushed
            ? `已推送到 ${result.remote || 'origin'}/${result.branch}`
            : `已提交到本地 ${result.branch}`
          : result.note || result.error || '没有可提交的改动'
        patch(projectId, {
          loading: false,
          lastAction: { kind: 'publish', at: Date.now(), ok: result.ok, message },
        })
        await get().refresh(projectId)
        return { ok: result.ok, note: message, url: result.url }
      } catch (err) {
        const message = err instanceof ApiError ? err.message : '提交失败'
        patch(projectId, { loading: false, error: message })
        throw err
      }
    },

    clear: (projectId) =>
      set((state) => {
        const next = { ...state.runtimes }
        delete next[projectId]
        return { runtimes: next }
      }),
  }
})
