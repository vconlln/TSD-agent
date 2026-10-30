import { create } from 'zustand'
import type { CreateProjectInput, Project } from '../../shared/types'
import { api, ApiError } from '../lib/api'

interface ProjectsState {
  projects: Project[]
  loading: boolean
  error: string | null
  loadedAt: number
  load: (force?: boolean) => Promise<void>
  create: (input: CreateProjectInput) => Promise<Project>
  remove: (id: string) => Promise<void>
  upsert: (project: Project) => void
  get: (id: string) => Project | undefined
  patch: (id: string, patch: Partial<Project>) => void
}

export const useProjectsStore = create<ProjectsState>((set, get) => ({
  projects: [],
  loading: false,
  error: null,
  loadedAt: 0,

  load: async (force = false) => {
    const { loading, loadedAt } = get()
    if (loading) return
    if (!force && Date.now() - loadedAt < 8000 && get().projects.length) return
    set({ loading: true, error: null })
    try {
      const res = await api.listProjects()
      set({ projects: res.projects ?? [], loading: false, loadedAt: Date.now() })
    } catch (err) {
      set({ loading: false, error: err instanceof ApiError ? err.message : '项目列表加载失败' })
    }
  },

  create: async (input) => {
    const project = await api.createProject(input)
    set((s) => ({ projects: [project, ...s.projects.filter((p) => p.id !== project.id)] }))
    return project
  },

  remove: async (id) => {
    await api.deleteProject(id)
    set((s) => ({ projects: s.projects.filter((p) => p.id !== id) }))
  },

  upsert: (project) =>
    set((s) => ({
      projects: s.projects.some((p) => p.id === project.id)
        ? s.projects.map((p) => (p.id === project.id ? project : p))
        : [project, ...s.projects],
    })),

  get: (id) => get().projects.find((p) => p.id === id),

  patch: (id, patch) =>
    set((s) => ({ projects: s.projects.map((p) => (p.id === id ? { ...p, ...patch } : p)) })),
}))
