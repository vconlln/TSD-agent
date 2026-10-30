import React from 'react'
import { createRoot } from 'react-dom/client'
import { HashRouter } from 'react-router-dom'
import App from './App'
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
