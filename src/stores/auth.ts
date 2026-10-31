import { create } from 'zustand'
import type { W3Model, W3Status } from '../../shared/types'
import { api, ApiError } from '../lib/api'
import { useAppStore } from './app'

interface AuthState {
  status: W3Status | null
  loading: boolean
  error: string | null
  login: (username: string, password: string) => Promise<W3Status>
  logout: () => Promise<void>
  refresh: () => Promise<void>
  useModel: (model: W3Model) => Promise<void>
}

export const useAuthStore = create<AuthState>((set, get) => ({
  status: null,
  loading: false,
  error: null,

  refresh: async () => {
    set({ loading: true, error: null })
    try {
      const status = await api.w3Status()
      set({ status, loading: false })
    } catch (err) {
      set({
        loading: false,
        error: err instanceof ApiError ? err.message : '无法读取 W3 登录状态',
      })
    }
  },

  login: async (username, password) => {
    set({ loading: true, error: null })
    try {
      const status = await api.w3Login(username, password)
      set({ status, loading: false })
      // 后端若返回了推理网关建议，直接落到引擎配置里，省掉手工填写。
      const suggested = (status as W3Status & {
        suggestedEngine?: { baseUrl?: string; apiKey?: string; model?: string }
      }).suggestedEngine
      if (suggested?.baseUrl) {
        await api.updateSettings({
          engine: {
            baseUrl: suggested.baseUrl,
            model: suggested.model || status.models[0]?.id || 'deepseek-chat',
            ...(suggested.apiKey ? { apiKey: suggested.apiKey } : {}),
          },
        })
        useAppStore.getState().setHealth(null)
      }
      return status
    } catch (err) {
      const message = err instanceof ApiError ? err.message : '登录失败'
      set({ loading: false, error: message })
      throw err
    }
  },

  logout: async () => {
    await api.w3Logout().catch(() => undefined)
    set({ status: { authenticated: false, configured: get().status?.configured ?? false, mode: get().status?.mode ?? 'demo', models: [] } })
  },

  useModel: async (model) => {
    await api.updateSettings({ engine: { model: model.id } })
    const status = get().status
    if (status) set({ status: { ...status, models: status.models } })
  },
}))
