import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { HealthInfo } from '../../shared/types'
import type { BackendStatus } from '../../shared/bridge'

export type ThemeId =
  | 'ochre'
  | 'violet'
  | 'ocean'
  | 'emerald'
  | 'sunset'
  | 'rose'
  | 'sakura'
  | 'graphite'
  | 'neon'
  | 'mocha'
  | 'mint'
  | 'indigo'
  | 'amber'
  | 'matrix'
export type Mode = 'dark' | 'light'
export type Density = 'cozy' | 'compact'
export type Effects = 'full' | 'calm' | 'off'

export interface Appearance {
  theme: ThemeId
  mode: Mode
  density: Density
  effects: Effects
  radius: number
  sidebarCollapsed: boolean
  codeWrap: boolean
  diffLayout: 'unified' | 'split'
  diffHighlight: boolean
  /** 字号缩放：只放大/缩小文字，不改布局密度 */
  fontScale: number
  /** 页面缩放：整个界面等比缩放（Electron 里走 zoomFactor，保持清晰） */
  uiZoom: number
  /** 自定义字体族名；空字符串表示使用内置字体 */
  fontSans: string
  fontDisplay: string
  fontMono: string
}

// 一个主题 = 一个色相。默认赭石：暖色打在冷墨上，是最不像「AI 默认紫」的选择。
export const THEMES: Array<{ id: ThemeId; name: string; from: string; to: string }> = [
  { id: 'ochre', name: '赭石', from: 'hsl(38 66% 60%)', to: 'hsl(38 66% 60%)' },
  { id: 'violet', name: '菫紫', from: 'hsl(268 58% 74%)', to: 'hsl(268 58% 74%)' },
  { id: 'ocean', name: '深海蓝', from: 'hsl(205 96% 58%)', to: 'hsl(168 88% 46%)' },
  { id: 'emerald', name: '翡翠绿', from: 'hsl(158 74% 45%)', to: 'hsl(184 84% 48%)' },
  { id: 'sunset', name: '落日橙', from: 'hsl(22 96% 58%)', to: 'hsl(342 88% 62%)' },
  { id: 'rose', name: '玫瑰红', from: 'hsl(344 88% 62%)', to: 'hsl(14 92% 62%)' },
  { id: 'sakura', name: '樱花粉', from: 'hsl(322 84% 68%)', to: 'hsl(264 80% 72%)' },
  { id: 'graphite', name: '石墨灰', from: 'hsl(220 12% 78%)', to: 'hsl(220 10% 52%)' },
  { id: 'neon', name: '霓虹赛博', from: 'hsl(300 100% 66%)', to: 'hsl(186 100% 58%)' },
  { id: 'mocha', name: '摩卡棕', from: 'hsl(28 62% 62%)', to: 'hsl(8 52% 54%)' },
  { id: 'mint', name: '薄荷青', from: 'hsl(168 76% 52%)', to: 'hsl(196 84% 56%)' },
  { id: 'indigo', name: '午夜靛', from: 'hsl(240 84% 70%)', to: 'hsl(270 80% 64%)' },
  { id: 'amber', name: '琥珀金', from: 'hsl(42 96% 58%)', to: 'hsl(22 92% 54%)' },
  { id: 'matrix', name: '终端绿', from: 'hsl(140 82% 52%)', to: 'hsl(96 74% 48%)' },
]

const DEFAULT_APPEARANCE: Appearance = {
  theme: 'ochre',
  mode: 'dark',
  density: 'cozy',
  effects: 'full',
  radius: 12,
  sidebarCollapsed: false,
  codeWrap: false,
  diffLayout: 'unified',
  diffHighlight: true,
  fontScale: 1,
  uiZoom: 1,
  fontSans: '',
  fontDisplay: '',
  fontMono: '',
}

/** 内置字体栈：自定义字体插在最前面，加载失败自动回落到这里 */
export const BASE_STACKS = {
  sans: "'IBM Plex Sans Variable', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'Noto Sans SC', sans-serif",
  display: "'Spline Sans Mono Variable', monospace",
  mono: "'JetBrains Mono Variable', 'SFMono-Regular', 'SF Mono', Menlo, Consolas, monospace",
}

export function stackFor(kind: 'sans' | 'display' | 'mono', family: string): string {
  const base = BASE_STACKS[kind]
  const trimmed = family.trim()
  return trimmed ? '"' + trimmed + '", ' + base : base
}

interface AppState {
  appearance: Appearance
  themePanelOpen: boolean
  backend: BackendStatus
  health: HealthInfo | null
  apiReady: boolean
  setAppearance: (patch: Partial<Appearance>) => void
  resetAppearance: () => void
  setThemePanelOpen: (open: boolean) => void
  setBackend: (status: BackendStatus) => void
  setHealth: (health: HealthInfo | null) => void
  setApiReady: (ready: boolean) => void
  applyToDocument: () => void
}

export const useAppStore = create<AppState>()(
  persist(
    (set, get) => ({
      appearance: DEFAULT_APPEARANCE,
      themePanelOpen: false,
      backend: { state: 'starting', url: '', mode: 'embedded' },
      health: null,
      apiReady: false,
      setAppearance: (patch) => {
        set((s) => ({ appearance: { ...s.appearance, ...patch } }))
        get().applyToDocument()
      },
      resetAppearance: () => {
        set({ appearance: DEFAULT_APPEARANCE })
        get().applyToDocument()
      },
      setThemePanelOpen: (themePanelOpen) => set({ themePanelOpen }),
      setBackend: (backend) => set({ backend }),
      setHealth: (health) => set({ health }),
      setApiReady: (apiReady) => set({ apiReady }),
      applyToDocument: () => {
        const { appearance } = get()
        const root = document.documentElement
        root.dataset.theme = appearance.theme
        root.dataset.mode = appearance.mode
        root.dataset.density = appearance.density
        root.dataset.effects = appearance.effects
        root.classList.toggle('dark', appearance.mode === 'dark')
        // 平台标记：CSS 据此选择字体平滑策略（Windows 保留 ClearType，最清晰）
        const platform = (window as unknown as { tsd?: { platform?: string } }).tsd?.platform
        root.dataset.platform = platform ?? 'web'
        root.style.setProperty('--radius', appearance.radius + 'px')
        // 字号缩放：所有文字尺寸都走 --text-* token，乘一个系数即可整体放大
        root.style.setProperty('--font-scale', String(appearance.fontScale || 1))
        // 自定义字体（系统字体扫描后可选），失败自动回落到内置字体栈
        root.style.setProperty('--font-sans', stackFor('sans', appearance.fontSans || ''))
        root.style.setProperty('--font-display', stackFor('display', appearance.fontDisplay || ''))
        root.style.setProperty('--font-mono', stackFor('mono', appearance.fontMono || ''))
        // 页面缩放：Electron 用 zoomFactor（矢量重排，高分屏不糊）；浏览器预览退回 CSS zoom
        const zoom = appearance.uiZoom || 1
        const bridge = (window as unknown as { tsd?: { setZoom?: (factor: number) => Promise<void> } }).tsd
        if (bridge && bridge.setZoom) {
          void bridge.setZoom(zoom)
          root.style.removeProperty('zoom')
        } else {
          root.style.setProperty('zoom', String(zoom))
        }
        const meta = document.querySelector('meta[name="theme-color"]')
        if (meta) meta.setAttribute('content', appearance.mode === 'dark' ? '#08090f' : '#f7f8fb')
      },
    }),
    {
      name: 'tsd.appearance.v1',
      version: 1,
      partialize: (state) => ({ appearance: state.appearance }),
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as { appearance?: Partial<Appearance> }
        return { ...current, appearance: { ...DEFAULT_APPEARANCE, ...(p.appearance ?? {}) } }
      },
    },
  ),
)

export { DEFAULT_APPEARANCE }
