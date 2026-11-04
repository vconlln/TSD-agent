import React from 'react'
import { createRoot } from 'react-dom/client'
import { HashRouter } from 'react-router-dom'
import App from './App'
// 自托管字体（随包分发，不依赖外网）：正文 IBM Plex Sans，显示/读数 Spline Sans Mono，代码 JetBrains Mono
import '@fontsource-variable/ibm-plex-sans'
import '@fontsource-variable/spline-sans-mono'
import '@fontsource-variable/jetbrains-mono'
import './index.css'
import { useAppStore } from './stores/app'

// Apply persisted appearance before first paint to avoid a theme flash.
useAppStore.getState().applyToDocument()

const container = document.getElementById('root')!
container.innerHTML = ''

createRoot(container).render(
  <React.StrictMode>
    <HashRouter>
      <App />
    </HashRouter>
  </React.StrictMode>,
)
