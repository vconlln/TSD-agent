import { useCallback, useEffect, useRef } from 'react'
import { api, setApiBase } from '@/lib/api'
import { useAppStore } from '@/stores/app'

/**
 * Connects the renderer to the Python backend.
 * - Electron: asks the main process for the supervised sidecar URL and listens
 *   for lifecycle events (starting → online → offline).
 * - Browser dev: falls back to VITE_API_BASE / 127.0.0.1:8791.
 */
export function useBackend() {
  const setBackend = useAppStore((s) => s.setBackend)
  const setHealth = useAppStore((s) => s.setHealth)
  const setApiReady = useAppStore((s) => s.setApiReady)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // 连续失败几次才判定「断开」：单次探测失败（引擎在跑大任务、系统忙）不该把页面打回「启动中」
  const failures = useRef(0)
  const probeHealth = useCallback(async () => {
    try {
      const health = await api.health()
      failures.current = 0
      setHealth(health)
      setApiReady(true)
      // Browser / preview mode has no IPC bridge: derive the status from health.
      if (!window.tsd) {
        setBackend({ state: 'online', url: api.base(), mode: 'embedded', version: health.version })
      }
      return true
    } catch {
      failures.current += 1
      if (failures.current >= 3) {
        setApiReady(false)
        setHealth(null)
        if (!window.tsd) {
          setBackend({ state: 'offline', url: api.base(), mode: 'embedded' })
        }
      }
      return false
    }
  }, [setBackend, setHealth, setApiReady])

  useEffect(() => {
    let disposed = false
    const bridge = window.tsd

    const boot = async () => {
      if (bridge) {
        const status = await bridge.getBackendStatus().catch(() => null)
        if (status && !disposed) {
          setBackend(status)
          if (status.url) setApiBase(status.url)
        }
        const unsubscribe = bridge.onBackendStatus((next) => {
          setBackend(next)
          if (next.url) setApiBase(next.url)
          if (next.state === 'online' || next.state === 'external') void probeHealth()
        })
        return () => unsubscribe()
      }
      return undefined
    }

    let unsubscribe: (() => void) | undefined
    void boot().then((fn) => {
      unsubscribe = fn
    })

    void probeHealth()
    timerRef.current = setInterval(() => {
      void probeHealth()
    }, 8000)

    return () => {
      disposed = true
      unsubscribe?.()
      if (timerRef.current) clearInterval(timerRef.current)
    }
  }, [probeHealth, setBackend])

  const retry = useCallback(async () => {
    const bridge = window.tsd
    if (bridge) {
      const status = await bridge.restartBackend().catch(() => null)
      if (status) {
        setBackend(status)
        if (status.url) setApiBase(status.url)
      }
    }
    await probeHealth()
  }, [probeHealth, setBackend])

  return { retry, probeHealth }
}
