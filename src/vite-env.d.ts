/// <reference types="vite/client" />

import type { TsdBridge } from '../shared/bridge'

declare global {
  interface Window {
    tsd?: TsdBridge
    __TSD_BOOT__?: { apiBase?: string; appVersion?: string; platform?: string }
  }
}
