/**
 * 无头截图 + UI 自检脚本（以 Electron 主进程运行）。
 *
 *   node_modules/electron/dist/electron --no-sandbox --ozone-platform=headless \
 *     --disable-gpu scripts/capture-screens.cjs
 *
 * 依赖：后端已在 127.0.0.1:8791 运行（含演示数据），可选 mock LLM 在 8799，
 * 且 dist/renderer 已构建。产物：docs/screenshots/*.png 与 capture-report.json。
 */
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..')
const OUT = path.join(ROOT, 'docs', 'screenshots')
const TMP = path.join(ROOT, 'scripts', 'e2e', '.tmp')
const RENDERER = path.join(ROOT, 'dist', 'renderer', 'index.html')
const API = 'http://127.0.0.1:8791'

app.disableHardwareAcceleration()
app.commandLine.appendSwitch('force-device-scale-factor', '2')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function api(pathname, init) {
  const res = await fetch(API + pathname, init)
  if (!res.ok) throw new Error(API + pathname + ' -> ' + res.status)
  return res.json()
}

const AUDIT_JS = String.raw`(() => {
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
    return {
      ok: true,
      scrollWidth: el.scrollWidth,
      innerWidth: window.innerWidth,
      bodyText: document.body.innerText.length,
      mainWidth: main ? Math.round(main.getBoundingClientRect().width) : 0,
      mainHeight: main ? Math.round(main.getBoundingClientRect().height) : 0,
      rootChildren: document.getElementById('root') ? document.getElementById('root').children.length : 0,
      buttons: document.querySelectorAll('button').length,
      overflow,
      theme: el.dataset.theme,
      mode: el.dataset.mode,
      background: window.getComputedStyle(document.body).backgroundColor,
      textExcerpt: document.body.innerText.split(String.fromCharCode(10)).join(' | ').slice(0, 700),
      rects,
    }
  } catch (error) {
    return { ok: false, error: String((error && error.stack) || error) }
  }
})()`

async function main() {
  const report = { consoleErrors: [], checks: [], shots: [], flags: {} }
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    show: false,
    backgroundColor: '#08090f',
    webPreferences: { offscreen: true, contextIsolation: true, nodeIntegration: false, sandbox: false },
  })

  win.webContents.on('console-message', (_event, level, message) => {
    if (level >= 2) report.consoleErrors.push(String(message).slice(0, 900))
  })
  win.webContents.on('render-process-gone', (_event, details) => {
    report.consoleErrors.push('render-process-gone: ' + JSON.stringify(details))
  })

  const { projects } = await api('/api/projects')
  const pageProject = projects.find((p) => p.name === '订单中心') || projects.find((p) => p.status === 'ready')
  const gitProject = projects.find((p) => p.name === 'micabc') || pageProject
  report.projects = projects.map((p) => ({ id: p.id, name: p.name, status: p.status }))
  report.projectId = pageProject.id
  report.gitProjectId = gitProject.id

  const load = async (hash, wait = 900) => {
    await win.loadURL('file://' + RENDERER + '#' + hash)
    await sleep(wait)
  }
  const hardLoad = async (hash = '/') => {
    await win.loadURL('file://' + RENDERER + '?r=' + Date.now() + '#' + hash)
    await sleep(1300)
  }
  const evalJs = (code) => win.webContents.executeJavaScript(code, true)
  const click = (text) =>
    evalJs(
      "(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim().includes(" +
        JSON.stringify(text) +
        ')); if (b) b.click(); return Boolean(b) })()',
    )
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
  }
  const SHOT_WIDTH = 1440 // 2x DPR 渲染后归一化到 1440，保证 README 里体积与清晰度平衡
  const shot = async (name) => {
    let image = await win.capturePage()
    if (image.getSize().width > SHOT_WIDTH) image = image.resize({ width: SHOT_WIDTH, quality: 'best' })
    const file = path.join(OUT, name + '.png')
    fs.writeFileSync(file, image.toPNG())
    const size = image.getSize()
    report.shots.push({ name, file: path.relative(ROOT, file), ...size })
    console.log('[shot] ' + name + ' ' + size.width + 'x' + size.height)
  }
  const applyThemeViaUi = async ({ mode, themeName }) => {
    await evalJs("(() => { const b = document.querySelector('button[aria-label=\"外观设置\"]'); if (b) b.click(); return Boolean(b) })()")
    await sleep(500)
    await click(mode === 'light' ? '浅色' : '深色')
    await sleep(350)
    if (themeName) {
      await evalJs("(() => { const b = document.querySelector('button[title=\"" + themeName + "\"]'); if (b) b.click(); return Boolean(b) })()")
    }
    await sleep(600)
  }

  fs.mkdirSync(OUT, { recursive: true })

  await load('/')
  await evalJs('localStorage.removeItem("tsd.appearance.v1"); true')
  await hardLoad('/')
  await load('/')
  await audit('workbench')
  await shot('01-workbench')

  await load('/project/' + pageProject.id + '?tab=overview')
  await audit('project-overview')
  await shot('02-project-overview')

  await load('/project/' + pageProject.id + '?tab=plan')
  await click('差异对比')
  await sleep(1500)
  await audit('plan-diff')
  await shot('03-plan-diff')

  await load('/project/' + pageProject.id + '?tab=code&side=target&path=src/auth.ts', 3000)
  await audit('code-view')
  await shot('04-code')

  await load('/project/' + pageProject.id + '?tab=diff', 2000)
  await click('并排')
  await sleep(1400)
  await audit('code-diff')
  await shot('05-diff-split')

  await load('/project/' + pageProject.id + '?tab=chat')
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
    // 流式回复：等到「思考 + 工具 + 补丁建议」都出现、并且不再处于生成中
    for (let attempt = 0; attempt < 150; attempt++) {
      await sleep(400)
      const state = await evalJs(
        "(() => { const t = document.body.innerText || ''; return {" +
        "streaming: t.includes('正在读取项目并思考') || t.includes('正在思考') || t.includes('Agent 正在工作')," +
        "done: t.includes('代码修改建议') || t.includes('应用到代码') || t.includes('离线模式')}; })()",
      )
      if (!state.streaming && state.done) break
      if (attempt === 120) await audit('chat-streaming')
    }
  }
  await sleep(1500)
  // 展开「已思考」折叠块，另存一张展示思考过程
  const expanded = await evalJs(
    "(() => { const buttons = [...document.querySelectorAll('button')]; const target = buttons.find((b) => (b.textContent || '').includes('已思考') || (b.textContent || '').includes('思考过程')); if (!target) return false; target.click(); return true })()",
  )
  if (expanded) {
    await sleep(600)
    await audit('chat-reasoning')
    await shot('14-chat-reasoning')
    await evalJs(
      "(() => { const buttons = [...document.querySelectorAll('button')]; const target = buttons.find((b) => (b.textContent || '').includes('已思考') || (b.textContent || '').includes('思考过程')); if (target) target.click(); return true })()",
    )
    await sleep(400)
  }
  await audit('chat')
  await shot('06-chat')

  await load('/project/' + pageProject.id + '?tab=overview')
  await evalJs("(() => { const b = document.querySelector('button[aria-label=\"外观设置\"]'); if (b) b.click(); return Boolean(b) })()")
  await sleep(700)
  await audit('theme-panel')
  await shot('07-theme-panel')

  await load('/')
  await sleep(300)
  await applyThemeViaUi({ mode: 'light', themeName: '深海蓝' })
  await hardLoad('/')
  await load('/')
  await audit('workbench-light')
  await shot('08-workbench-light')

  await applyThemeViaUi({ mode: 'dark', themeName: '极光紫' })
  await hardLoad('/settings')
  await load('/settings')
  await audit('settings-w3')
  await shot('09-settings-w3')

  await load('/project/' + gitProject.id + '?tab=git', 1500)
  await audit('git-tab')
  await shot('10-git-tab')

  // Agent 轨迹（回放已完成运行的 agent.* 事件）
  await load('/project/' + gitProject.id + '?tab=agent', 2200)
  await audit('agent-tab')
  await shot('13-agent-tab')

  await load('/project/' + gitProject.id + '?tab=code&side=target&path=src/index.ts', 3200)
  // 编辑器头部（含「修改」按钮）要等文件内容与 Monaco 就绪，点击需要重试
  let dialogOpen = false
  for (let attempt = 0; attempt < 20 && !dialogOpen; attempt++) {
    await click('修改')
    await sleep(500)
    dialogOpen = await evalJs("document.body.innerText.includes('AI 修改代码')")
  }
  if (dialogOpen) {
    // 注意：Monaco 自己有一个隐藏 textarea，必须按 placeholder 精确选中对话框里的输入框
    const filled = await evalJs(`(() => {
      const ta = [...document.querySelectorAll('textarea')].find((t) => (t.placeholder || '').startsWith('描述要做的修改'))
      if (!ta) return false
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
      setter.call(ta, '为这个函数补充中文注释，并说明参数含义')
      ta.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    })()`)
    console.log('[capture] modify dialog textarea filled: ' + filled)
    await click('生成修改')
    for (let attempt = 0; attempt < 60; attempt++) {
      await sleep(500)
      const ready = await evalJs("document.body.innerText.includes('审阅 AI 修改')")
      if (ready) break
    }
    await sleep(1800)
    report.flags.editorAiReview = await evalJs(
      "document.body.innerText.includes('审阅 AI 修改') && document.body.innerText.includes('接受并写入')",
    )
    await audit('editor-ai-diff')
    await shot('11-editor-ai-diff')
  }

  await load('/project/' + gitProject.id + '?tab=code&side=target&path=src/index.ts', 3200)
  let explainOpen = false
  for (let attempt = 0; attempt < 20 && !explainOpen; attempt++) {
    await click('解释')
    await sleep(600)
    explainOpen = await evalJs("document.body.innerText.includes('AI 解释')")
  }
  for (let attempt = 0; attempt < 40; attempt++) {
    await sleep(400)
    const ready = await evalJs("document.body.innerText.includes('结论') || document.body.innerText.includes('离线分析')")
    if (ready) break
  }
  await sleep(1400)
  report.flags.editorExplainPanel = await evalJs(
    "document.body.innerText.includes('AI 解释') && (document.body.innerText.includes('结论') || document.body.innerText.includes('概览'))",
  )
  await audit('editor-explain')
  await shot('12-editor-explain')

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
          ' overflow=' + check.overflow.length,
      )
    }
  }
  console.log('[flags] ' + JSON.stringify(report.flags))
  console.log('[console errors] ' + report.consoleErrors.length)
  report.consoleErrors.slice(0, 8).forEach((line) => console.log('  ! ' + line))

  app.exit(failures.length === 0 && report.consoleErrors.length === 0 ? 0 : 1)
}

app.whenReady().then(() =>
  main().catch((error) => {
    console.error('[capture] failed:', error)
    app.exit(2)
  }),
)
