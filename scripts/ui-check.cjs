/**
 * 路由 / 页面自检：在无头 Electron 里走一遍主要页面组合，收集控制台错误与渲染结果。
 *
 *   node_modules/electron/dist/electron --no-sandbox --ozone-platform=headless \
 *     --disable-gpu scripts/ui-check.cjs [--api http://127.0.0.1:8791] [--out report.json]
 *
 * 用途：抓「切页面白屏 / 组件崩溃 / 请求 500」这类只在真实渲染里才暴露的问题。
 */
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..')
const RENDERER = path.join(ROOT, 'dist', 'renderer', 'index.html')

function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

const API = arg('api', 'http://127.0.0.1:8791')
const OUT = arg('out', path.join(ROOT, 'scripts', 'e2e', '.tmp', 'ui-check.json'))

app.disableHardwareAcceleration()

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function api(pathname, init) {
  const res = await fetch(API + pathname, init)
  const text = await res.text()
  if (!res.ok) throw new Error(pathname + ' -> ' + res.status + ' ' + text.slice(0, 200))
  return text ? JSON.parse(text) : {}
}

const AUDIT = '(() => {' +
  'const root = document.getElementById("root");' +
  'const main = document.querySelector("main");' +
  'const text = document.body.innerText || "";' +
  'return {hasRoot: Boolean(root), rootChildren: root ? root.children.length : 0,' +
  ' bodyText: text.length, text: text.split(String.fromCharCode(10)).join(" | ").slice(0, 400),' +
  ' buttons: document.querySelectorAll("button").length,' +
  ' mainHeight: main ? Math.round(main.getBoundingClientRect().height) : 0,' +
  ' scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth};' +
  '})()'

async function main() {
  const report = { api: API, consoleErrors: [], pageErrors: [], steps: [] }
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    show: false,
    backgroundColor: '#08090f',
    webPreferences: { offscreen: true, contextIsolation: true, nodeIntegration: false, sandbox: false },
  })
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) report.consoleErrors.push(String(message).slice(0, 600))
  })
  win.webContents.on('render-process-gone', (_e, d) => report.pageErrors.push('render-gone ' + JSON.stringify(d)))

  const evalJs = (code) => win.webContents.executeJavaScript(code, true)
  const go = async (hash, wait) => {
    await win.loadURL('file://' + RENDERER + '?t=' + Date.now() + '#' + hash)
    await sleep(wait || 1100)
    return evalJs(AUDIT)
  }
  const route = async (hash, expect) => {
    const before = report.consoleErrors.length
    const data = await go(hash)
    const errors = report.consoleErrors.slice(before)
    // 期望文本要在整页 innerText 里判断：审计里的 text 只截前 400 字，页签等文字通常在其后
    const expectOk = expect
      ? await evalJs('document.body.innerText.includes(' + JSON.stringify(expect) + ')')
      : true
    const ok =
      data.rootChildren > 0 &&
      data.bodyText > 80 &&
      data.mainHeight > 300 &&
      errors.length === 0 &&
      expectOk
    report.steps.push(Object.assign({ hash: hash, ok: ok, expect: expect || null, errors: errors }, data))
    console.log((ok ? 'PASS ' : 'FAIL ') + hash + ' text=' + data.bodyText + ' h=' + data.mainHeight + (errors.length ? ' errors=' + errors.length : ''))
    return data
  }

  try {
    const listing = await api('/api/projects')
    const projects = listing.projects || []
    const ready = projects.find((p) => p.status === 'ready') || projects[0]
    report.projectId = ready ? ready.id : null
    if (!ready) throw new Error('没有可用的演示项目，先跑 npm run seed:demo')

    await route('/', '工作台')
    await route('/projects', '项目库')
    await route('/settings', '设置')
    // 用户报的问题：项目 → 设置
    await route('/project/' + ready.id + '?tab=overview', '概览')
    await route('/settings', '设置')
    await route('/project/' + ready.id + '?tab=code', '代码')
    await route('/settings', '设置')
    await route('/project/' + ready.id + '?tab=chat', '对话')
    await route('/settings', '设置')
    await route('/project/' + ready.id + '?tab=agent', 'Agent')
    await route('/settings', '设置')

    const created = await api('/api/projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'UI 自检项目',
        source: { kind: 'page', url: 'https://example.com/plan' },
        targetVersion: '9.9.9',
      }),
    })
    report.createdProjectId = created.project ? created.project.id : created.id
    await route('/projects', '项目库')
    await route('/project/' + report.createdProjectId + '?tab=overview')
    await route('/settings', '设置')
    await route('/project/' + report.createdProjectId + '?tab=overview')
    await route('/settings', '设置')

    // —— 侧栏不再溢出（用户报的 bug）+ 字号缩放真的生效
    await route('/projects', '项目库')
    const sidebarAudit = await evalJs(
      '(() => {' +
        'const aside = document.querySelector("aside");' +
        'if (!aside) return { ok: false, reason: "无侧栏" };' +
        'let overflowRows = 0;' +
        'const rows = [...aside.querySelectorAll("a")];' +
        'for (const row of rows) {' +
          'const rr = row.getBoundingClientRect();' +
          'for (const child of row.querySelectorAll("span")) {' +
            'const cr = child.getBoundingClientRect();' +
            'if (cr.width > 0 && cr.right - rr.right > 1) overflowRows += 1;' +
          '}' +
        '}' +
        'const root = document.documentElement;' +
        'const baseSize = parseFloat(getComputedStyle(document.body).fontSize);' +
        'root.style.setProperty("--font-scale", "1.2");' +
        'const scaledSize = parseFloat(getComputedStyle(document.body).fontSize);' +
        'root.style.setProperty("--font-scale", "1");' +
        'return { ok: true, rows: rows.length, overflowRows, baseSize, scaledSize,' +
          ' platform: root.dataset.platform || "" };' +
      '})()',
    )
    const sidebarOk = Boolean(sidebarAudit.ok) && sidebarAudit.overflowRows === 0 &&
      sidebarAudit.scaledSize > sidebarAudit.baseSize
    report.steps.push({ hash: 'sidebar 溢出 + 字号缩放', ok: sidebarOk, errors: [], ...sidebarAudit })
    console.log((sidebarOk ? 'PASS ' : 'FAIL ') + 'sidebar rows=' + sidebarAudit.rows +
      ' overflow=' + sidebarAudit.overflowRows + ' fontScale ' + sidebarAudit.baseSize + '→' + sidebarAudit.scaledSize +
      ' platform=' + sidebarAudit.platform)

    const opened = await evalJs('(() => { const b = document.querySelector("button[aria-label=\\"外观设置\\"]"); if (!b) return false; b.click(); return true })()')
    await sleep(800)
    const panelText = await evalJs('document.body.innerText.includes("主题") || document.body.innerText.includes("外观")')
    report.steps.push({ hash: 'settings+theme-panel', ok: Boolean(opened) && Boolean(panelText), opened: opened, panelText: panelText })
    // —— 对话：真实走一遍流式（思考 / 工具 / 提案 / Markdown 渲染）
    await route('/project/' + ready.id + '?tab=chat', '对话')
    const sent = await evalJs(
      '(() => {' +
        'const ta = document.querySelector("textarea");' +
        'if (!ta) return false;' +
        'const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;' +
        'setter.call(ta, "给 createOrder 加金额校验，并把待办写成文档");' +
        'ta.dispatchEvent(new Event("input", { bubbles: true }));' +
        'ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));' +
        'return true;' +
      '})()',
    )
    let chatDone = false
    for (let attempt = 0; attempt < 150 && sent; attempt++) {
      await sleep(400)
      const state = await evalJs(
        '(() => {' +
          'const text = document.body.innerText || "";' +
          'return {suggestions: text.includes("有什么可以帮你的"),' +
          ' streaming: text.includes("正在读取项目并思考") || text.includes("正在思考"),' +
          ' proposal: text.includes("代码修改建议")};' +
        '})()',
      )
      if (!state.suggestions && !state.streaming && state.proposal) {
        chatDone = true
        break
      }
    }
    await sleep(700)
    const chatAudit = await evalJs(
      '(() => {' +
        'const text = document.body.innerText || "";' +
        'const main = document.querySelector("main");' +
        'return {hasReasoning: text.includes("已思考") || text.includes("思考过程"),' +
        ' hasTools: text.includes("list_files") || text.includes("propose_edit"),' +
        ' hasProposal: text.includes("代码修改建议"),' +
        ' hasApply: text.includes("应用到代码"),' +
        ' markdown: Boolean(document.querySelector("h3, strong, code")),' +
        ' text: text.split(String.fromCharCode(10)).join(" | ").slice(0, 500),' +
        ' mainHeight: main ? Math.round(main.getBoundingClientRect().height) : 0};' +
      '})()',
    )
    if (report.createdProjectId) {
      await api('/api/projects/' + report.createdProjectId, { method: 'DELETE' }).catch(() => undefined)
    }
    // —— 按钮 loading 态：不能挤动图标、不能改变按钮尺寸
    await route('/settings', '设置')
    const loadProbe = await evalJs(
      '(() => {' +
        'const orig = window.fetch.bind(window);' +
        'window.__tsdOrigFetch = orig;' +
        'window.fetch = (input, init) => {' +
          'const url = typeof input === "string" ? input : (input && input.url) || "";' +
          'const method = (init && init.method) || "GET";' +
          'if (url.indexOf("/api/settings") >= 0 && method === "PUT") {' +
            'return new Promise((resolve) => setTimeout(() => resolve(orig(input, init)), 1600));' +
          '}' +
          'return orig(input, init);' +
        '};' +
        'const buttons = [...document.querySelectorAll("button")];' +
        'const target = buttons.find((b) => (b.textContent || "").trim() === "保存") || buttons.find((b) => (b.textContent || "").includes("保存"));' +
        'if (!target) return { ok: false, reason: "找不到保存按钮" };' +
        'const r = target.getBoundingClientRect();' +
        'target.click();' +
        'return { ok: true, rect: { w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.x), y: Math.round(r.y) } };' +
      '})()',
    )
    await sleep(450)
    const loadingState = await evalJs(
      '(() => {' +
        'const buttons = [...document.querySelectorAll("button")];' +
        'const target = buttons.find((b) => b.getAttribute("aria-busy") === "true") || buttons.find((b) => (b.textContent || "").includes("保存"));' +
        'if (!target) return { ok: false, reason: "没有按钮进入 loading 态" };' +
        'const r = target.getBoundingClientRect();' +
        'const spinner = target.querySelector("svg.animate-spin");' +
        'const content = target.querySelector("span");' +
        'const contentStyle = content ? window.getComputedStyle(content) : null;' +
        'const spinnerRect = spinner ? spinner.getBoundingClientRect() : null;' +
        'return { ok: true,' +
          ' busy: target.getAttribute("aria-busy") === "true",' +
          ' rect: { w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.x), y: Math.round(r.y) },' +
          ' hasSpinner: Boolean(spinner),' +
          ' spinnerCentered: spinnerRect ? (Math.abs((spinnerRect.x + spinnerRect.width / 2) - (r.x + r.width / 2)) < 2 && Math.abs((spinnerRect.y + spinnerRect.height / 2) - (r.y + r.height / 2)) < 2) : false,' +
          ' contentHidden: contentStyle ? contentStyle.visibility === "hidden" : false,' +
          ' iconCount: target.querySelectorAll("svg").length' +
        '};' +
      '})()',
    )
    await evalJs('(() => { if (window.__tsdOrigFetch) window.fetch = window.__tsdOrigFetch; return true })()')
    const sizeStable = loadProbe.ok && loadingState.ok &&
      Math.abs(loadingState.rect.w - loadProbe.rect.w) <= 1 &&
      Math.abs(loadingState.rect.h - loadProbe.rect.h) <= 1 &&
      Math.abs(loadingState.rect.x - loadProbe.rect.x) <= 1 &&
      Math.abs(loadingState.rect.y - loadProbe.rect.y) <= 1
    const loadingOk = sizeStable && loadingState.hasSpinner && loadingState.contentHidden && loadingState.spinnerCentered
    report.steps.push({
      hash: '/settings (button loading)',
      ok: Boolean(loadingOk),
      errors: [],
      before: loadProbe, after: loadingState, sizeStable,
    })
    console.log((loadingOk ? 'PASS ' : 'FAIL ') + 'button-loading sizeStable=' + sizeStable +
      ' spinner=' + loadingState.hasSpinner + ' centered=' + loadingState.spinnerCentered +
      ' contentHidden=' + loadingState.contentHidden)

    const chatOk =
      Boolean(sent) && chatDone && chatAudit.hasReasoning && chatAudit.hasTools &&
      chatAudit.hasProposal && chatAudit.mainHeight > 300
    report.steps.push(Object.assign({ hash: '/project?tab=chat', ok: chatOk, errors: [] }, chatAudit))
    console.log((chatOk ? 'PASS ' : 'FAIL ') + 'chat-stream reasoning=' + chatAudit.hasReasoning +
      ' tools=' + chatAudit.hasTools + ' proposal=' + chatAudit.hasProposal)
  } catch (error) {
    report.pageErrors.push(String((error && error.stack) || error))
  }

  fs.mkdirSync(path.dirname(OUT), { recursive: true })
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2))
  const failed = report.steps.filter((s) => !s.ok)
  console.log('\n[ui-check] steps=' + report.steps.length + ' failed=' + failed.length +
    ' consoleErrors=' + report.consoleErrors.length + ' pageErrors=' + report.pageErrors.length)
  for (const step of failed) console.log('  FAIL ' + step.hash + ' :: ' + JSON.stringify(step.errors || {}).slice(0, 500))
  for (const err of report.pageErrors) console.log('  PAGE ERROR ' + err.slice(0, 500))
  app.exit(failed.length === 0 && report.consoleErrors.length === 0 && report.pageErrors.length === 0 ? 0 : 1)
}

app.whenReady().then(main).catch((error) => {
  console.error(error)
  app.exit(1)
})
