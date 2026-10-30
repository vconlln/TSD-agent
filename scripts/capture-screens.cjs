/**
 * 无头截图 + UI 自检脚本（以 Electron 主进程运行）。
 *
 *   node_modules/electron/dist/electron --no-sandbox --ozone-platform=headless \
 *     --disable-gpu scripts/capture-screens.cjs
 *
 * 依赖：后端已在 127.0.0.1:8791 运行，且 dist/renderer 已构建。
 * 产物：docs/screenshots/*.png 与 scripts/e2e/.tmp/capture-report.json
 */
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..')
const OUT = path.join(ROOT, 'docs', 'screenshots')
const TMP = path.join(ROOT, 'scripts', 'e2e', '.tmp')
const RENDERER = path.join(ROOT, 'dist', 'renderer', 'index.html')
const API = 'http://127.0.0.1:8791'

const DARK_VIOLET = { theme: 'violet', mode: 'dark', density: 'cozy', effects: 'full', radius: 12, sidebarCollapsed: false, codeWrap: false, diffLayout: 'unified', diffHighlight: true }
const LIGHT_OCEAN = { theme: 'ocean', mode: 'light', density: 'cozy', effects: 'calm', radius: 14, sidebarCollapsed: false, codeWrap: false, diffLayout: 'unified', diffHighlight: true }

app.disableHardwareAcceleration()
app.commandLine.appendSwitch('force-device-scale-factor', '2')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function api(pathname, init) {
  const res = await fetch(API + pathname, init)
  if (!res.ok) throw new Error(API + pathname + ' -> ' + res.status)
  return res.json()
}

const AUDIT_JS = `(() => {
  try {
    const el = document.documentElement
    const main = document.querySelector('main')
    const rects = {}
    const put = (key, sel) => {
      const node = document.querySelector(sel)
      if (!node) return
      const r = node.getBoundingClientRect()
      rects[key] = [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)]
    }
    put('titlebar', 'header')
    put('sidebar', 'aside')
    put('main', 'main')
    const isClipped = (node) => {
      let parent = node.parentElement
      while (parent) {
        const style = window.getComputedStyle(parent)
        if (style.overflowX !== 'visible' || style.overflowY !== 'visible') return true
        parent = parent.parentElement
      }
      return false
    }
    const overflow = []
    for (const node of document.querySelectorAll('body *')) {
      const rect = node.getBoundingClientRect()
      if (rect.width <= 0 || rect.height <= 0) continue
      const style = window.getComputedStyle(node)
      if (style.position === 'fixed' || style.overflowX !== 'visible' || style.overflowY !== 'visible') continue
      if (rect.right > window.innerWidth + 2 || rect.left < -2) {
        if (isClipped(node)) continue
        const name = typeof node.className === 'string' ? node.className : node.tagName
        overflow.push(String(name).slice(0, 60))
        if (overflow.length >= 6) break
      }
    }
    const tiny = []
    for (const button of document.querySelectorAll('button')) {
      const rect = button.getBoundingClientRect()
      if (rect.width > 0 && rect.height > 0 && rect.height < 18) tiny.push(button.textContent.trim().slice(0, 12) || button.getAttribute('aria-label') || 'icon')
    }
    return {
      ok: true,
      scrollWidth: el.scrollWidth,
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      bodyText: document.body.innerText.length,
      mainWidth: main ? Math.round(main.getBoundingClientRect().width) : 0,
      mainHeight: main ? Math.round(main.getBoundingClientRect().height) : 0,
      rootChildren: document.getElementById('root') ? document.getElementById('root').children.length : 0,
      buttons: document.querySelectorAll('button').length,
      overflow,
      tinyButtons: tiny,
      theme: el.dataset.theme,
      mode: el.dataset.mode,
      background: window.getComputedStyle(document.body).backgroundColor,
      primary: window.getComputedStyle(el).getPropertyValue('--primary').trim(),
      textExcerpt: document.body.innerText.split(String.fromCharCode(10)).join(' | ').slice(0, 700),
      rects,
    }
  } catch (error) {
    return { ok: false, error: String((error && error.stack) || error) }
  }
})()`

async function main() {
  const report = { consoleErrors: [], checks: [], shots: [] }

  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    show: false,
    backgroundColor: '#08090f',
    webPreferences: {
      offscreen: true,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  win.webContents.on('console-message', (_event, level, message) => {
    if (level >= 2) report.consoleErrors.push(String(message).slice(0, 900))
  })
  win.webContents.on('render-process-gone', (_event, details) => {
    report.consoleErrors.push('render-process-gone: ' + JSON.stringify(details))
  })

  const { projects } = await api('/api/projects')
  const project = projects.find((p) => p.status === 'ready') || projects[0]
  const projectId = project.id
  report.projectId = projectId
  report.projectName = project.name
  report.projects = projects.map((p) => ({ id: p.id, name: p.name, status: p.status }))

  const load = async (hash) => {
    await win.loadURL('file://' + RENDERER + '#' + hash)
    await sleep(900)
  }

  let evalLabel = 'eval'
  const evalJs = async (code) => {
    try {
      return await win.webContents.executeJavaScript(code, true)
    } catch (error) {
      console.log('[eval:' + evalLabel + '] failed: ' + (error && error.message))
      throw error
    }
  }

  // Full document load (unique query) — hash-only changes never re-read persisted state.
  const hardLoad = async (hash = '/') => {
    await win.loadURL('file://' + RENDERER + '?r=' + Date.now() + '#' + hash)
    await sleep(1300)
  }

  const applyThemeViaUi = async ({ mode, themeName }) => {
    await evalJs("(() => { const b = document.querySelector('button[aria-label=\"外观设置\"]'); if (b) b.click(); return Boolean(b) })()")
    await sleep(500)
    await click(mode === 'light' ? '浅色' : '深色')
    await sleep(350)
    if (themeName) await evalJs("(() => { const b = document.querySelector('button[title=\"" + themeName + "\"]'); if (b) b.click(); return Boolean(b) })()")
    await sleep(600)
    const state = await evalJs("[document.documentElement.dataset.mode, document.documentElement.dataset.theme]")
    console.log('[theme] now ' + JSON.stringify(state))
    return state
  }

  const audit = async (label) => {
    const data = await evalJs(AUDIT_JS)
    if (!data.ok) {
      report.checks.push({ label, ok: false, error: data.error })
      console.log('[audit] ' + label + ' ERROR ' + data.error)
      return
    }
    const ok =
      data.scrollWidth <= data.innerWidth + 1 &&
      data.bodyText > 120 &&
      data.rootChildren > 0 &&
      data.overflow.length === 0 &&
      data.mainHeight > 400
    report.checks.push({ label, ok, ...data })
    return data
  }

  const shot = async (name) => {
    const image = await win.capturePage()
    const file = path.join(OUT, name + '.png')
    fs.writeFileSync(file, image.toPNG())
    const size = image.getSize()
    report.shots.push({ name, file: path.relative(ROOT, file), ...size })
    console.log('[shot] ' + name + ' ' + size.width + 'x' + size.height)
  }

  const click = (text) =>
    evalJs(
      "(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.includes(" +
        JSON.stringify(text) +
        ')); if (b) b.click(); return Boolean(b) })()',
    )

  fs.mkdirSync(OUT, { recursive: true })

  // Start from a clean appearance state so screenshots are reproducible.
  await load('/')
  await evalJs('localStorage.removeItem("tsd.appearance.v1"); true')
  await hardLoad('/')
  await load('/')
  await audit('workbench')
  await shot('01-workbench')

  await load('/project/' + projectId + '?tab=overview')
  await sleep(800)
  await audit('project-overview')
  await shot('02-project-overview')

  await load('/project/' + projectId + '?tab=plan')
  await sleep(700)
  await click('差异对比')
  await sleep(1500)
  await audit('plan-diff')
  await shot('03-plan-diff')

  await load('/project/' + projectId + '?tab=code&side=target&path=src/auth.ts')
  await sleep(1700)
  await audit('code-view')
  await shot('04-code')

  await load('/project/' + projectId + '?tab=diff')
  await sleep(2000)
  await click('并排')
  await sleep(1400)
  await audit('code-diff')
  await shot('05-diff-split')

  await load('/project/' + projectId + '?tab=chat')
  await sleep(700)
  const sent = await evalJs(`(() => {
    const ta = document.querySelector('textarea')
    if (!ta) return false
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
    setter.call(ta, '请把迁移脚本的待办事项也补充到 UPGRADE_NOTES.md')
    ta.dispatchEvent(new Event('input', { bubbles: true }))
    const button = document.querySelector('button[aria-label="发送"]')
    if (button) button.click()
    return Boolean(button)
  })()`)
  if (sent) {
    for (let attempt = 0; attempt < 40; attempt++) {
      await sleep(500)
      const done = await evalJs(
        "document.body.innerText.includes('代码修改建议') || document.body.innerText.includes('已应用到') || document.body.innerText.includes('离线模式')",
      )
      if (done) break
    }
  }
  await sleep(1200)
  await audit('chat')
  await shot('06-chat')

  await load('/project/' + projectId + '?tab=overview')
  await evalJs("(() => { const b = document.querySelector('button[aria-label=\"外观设置\"]'); if (b) b.click(); return Boolean(b) })()")
  await sleep(700)
  await audit('theme-panel')
  await shot('07-theme-panel')

  await load('/')
  await sleep(400)
  await applyThemeViaUi({ mode: 'light', themeName: '深海蓝' })
  await hardLoad('/')
  await load('/')
  await sleep(800)
  await audit('workbench-light')
  await shot('08-workbench-light')

  await applyThemeViaUi({ mode: 'dark', themeName: '极光紫' })
  await hardLoad('/settings')
  await sleep(600)
  await load('/settings')
  await sleep(800)
  await audit('settings')
  await shot('09-settings')

  fs.mkdirSync(TMP, { recursive: true })
  fs.writeFileSync(path.join(TMP, 'capture-report.json'), JSON.stringify(report, null, 2))

  const failures = report.checks.filter((c) => !c.ok)
  console.log('\n[checks] ' + report.checks.length + '  failures: ' + failures.length)
  for (const check of report.checks) {
    if (!check.error) {
      console.log(
        '  ' + (check.ok ? 'PASS' : 'FAIL') + ' ' + check.label +
          ' theme=' + check.mode + '/' + check.theme +
          ' text=' + check.bodyText +
          ' overflow=' + check.overflow.length +
          ' main=' + check.mainWidth + 'x' + check.mainHeight,
      )
    }
  }
  for (const check of report.checks) {
    if (check.textExcerpt) console.log('\n[' + check.label + '] ' + check.textExcerpt.slice(0, 420))
  }
  console.log('\n[console errors] ' + report.consoleErrors.length)
  report.consoleErrors.slice(0, 8).forEach((line) => console.log('  ! ' + line))

  app.exit(failures.length === 0 && report.consoleErrors.length === 0 ? 0 : 1)
}

app.whenReady().then(() =>
  main().catch((error) => {
    console.error('[capture] failed:', error)
    app.exit(2)
  }),
)
