import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function formatBytes(bytes = 0, digits = 1): string {
  if (!bytes) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : digits)} ${units[i]}`
}

export function formatDuration(ms = 0): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`
  const s = ms / 1000
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)}s`
  const m = Math.floor(s / 60)
  const rest = Math.round(s % 60)
  if (m < 60) return `${m}m ${rest}s`
  const h = Math.floor(m / 60)
  return `${h}h ${m % 60}m`
}

export function formatRelative(ts?: number): string {
  if (!ts) return '—'
  const diff = Date.now() - ts
  const abs = Math.abs(diff)
  if (abs < 60_000) return '刚刚'
  const suffix = diff >= 0 ? '前' : '后'
  const mins = Math.round(abs / 60_000)
  if (mins < 60) return `${mins} 分钟${suffix}`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `${hours} 小时${suffix}`
  const days = Math.round(hours / 24)
  if (days < 30) return `${days} 天${suffix}`
  return new Date(ts).toLocaleDateString('zh-CN')
}

export function formatClock(ts?: number): string {
  if (!ts) return '--:--:--'
  return new Date(ts).toLocaleTimeString('zh-CN', { hour12: false })
}

export function formatDateTime(ts?: number): string {
  if (!ts) return '—'
  return new Date(ts).toLocaleString('zh-CN', { hour12: false })
}

export function uid(prefix = ''): string {
  return `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
}

export function debounce<T extends (...args: never[]) => void>(fn: T, wait = 200) {
  let timer: ReturnType<typeof setTimeout> | undefined
  return (...args: Parameters<T>) => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => fn(...args), wait)
  }
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    try {
      const el = document.createElement('textarea')
      el.value = text
      el.style.position = 'fixed'
      el.style.opacity = '0'
      document.body.appendChild(el)
      el.select()
      document.execCommand('copy')
      document.body.removeChild(el)
      return true
    } catch {
      return false
    }
  }
}

export function clamp(n: number, min: number, max: number) {
  return Math.min(max, Math.max(min, n))
}

export function initials(name: string): string {
  const trimmed = name.trim()
  if (!trimmed) return 'TS'
  const ascii = trimmed.replace(/[^\u0000-\u007F]/g, '')
  if (ascii.length >= 2) {
    const parts = ascii.split(/[\s_-]+/).filter(Boolean)
    if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase()
    return ascii.slice(0, 2).toUpperCase()
  }
  return trimmed.slice(0, 2)
}

/** Deterministic pastel hue for project chips. */
export function hueOf(seed: string): number {
  let h = 0
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) % 360
  return h
}

export function stripCodeFence(text: string): string {
  const fence = text.match(/^\`\`\`[\w-]*\n([\s\S]*?)\`\`\`\s*$/m)
  return fence ? fence[1] : text
}

export function safeParse<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}
