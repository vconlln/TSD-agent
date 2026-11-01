#!/usr/bin/env node
/**
 * 契约自检：拿你（内网）的后端跑一遍前端真正会发的请求，逐条核对「路径 / 状态码 / JSON 形状」。
 *
 *   node scripts/contract-check.mjs --api http://10.0.0.5:8000
 *   node scripts/contract-check.mjs --api http://10.0.0.5:8000 --read-only   # 不创建/不跑任务
 *   node scripts/contract-check.mjs --api http://10.0.0.5:8000 --json        # 机器可读报告
 *
 * 退出码：0 = 必需项全部通过；1 = 有必需项不通过；2 = 参数/连接问题。
 *
 * 说明：只做只读与最小写入（创建 1 个测试项目 → 跑一次流水线 → 删除），不会碰你的真实数据；
 * 跑不动流水线时用 --read-only 只看静态接口。
 */
import { setTimeout as sleep } from 'node:timers/promises'

function parseArgs(argv) {
  const options = { api: 'http://127.0.0.1:8791', readOnly: false, json: false, timeoutMs: 20000, keep: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const next = () => {
      const value = argv[i + 1]
      if (!value || value.startsWith('--')) throw new Error(arg + ' 需要一个值')
      i += 1
      return value
    }
    switch (arg) {
      case '--api': options.api = next().replace(/\/$/, ''); break
      case '--read-only': options.readOnly = true; break
      case '--json': options.json = true; break
      case '--keep': options.keep = true; break
      case '--timeout': options.timeoutMs = Number(next()); break
      case '--help': case '-h': options.help = true; break
      default: throw new Error('未知参数：' + arg)
    }
  }
  return options
}

const results = []

function record(group, name, ok, detail) {
  results.push({ group, name, ok, detail: detail || '' })
}

async function http(options, path, init) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs)
  try {
    const response = await fetch(options.api + path, {
      ...init,
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json', ...(init && init.headers ? init.headers : {}) },
    })
    const text = await response.text()
    let body = null
    try {
      body = text ? JSON.parse(text) : null
    } catch {
      body = text
    }
    return { ok: response.ok, status: response.status, body }
  } catch (error) {
    return { ok: false, status: 0, body: null, error: String((error && error.message) || error) }
  } finally {
    clearTimeout(timer)
  }
}

function requireFields(group, name, value, fields) {
  if (!value || typeof value !== 'object') {
    record(group, name, false, '响应不是对象')
    return false
  }
  const missing = fields.filter((field) => value[field] === undefined || value[field] === null)
  record(group, name, missing.length === 0, missing.length ? '缺字段：' + missing.join(', ') : 'ok')
  return missing.length === 0
}

async function readSse(options, runId, path, waitMs) {
  const controller = new AbortController()
  const deadline = Date.now() + waitMs
  const timer = setTimeout(() => controller.abort(), waitMs)
  const events = []
  let buffer = ''
  try {
    const response = await fetch(options.api + path, {
      signal: controller.signal,
      headers: { Accept: 'text/event-stream' },
    })
    if (!response.ok || !response.body) return { status: response.status, events }
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    while (Date.now() < deadline) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let index
      while ((index = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, index)
        buffer = buffer.slice(index + 2)
        for (const line of frame.split('\n')) {
          if (!line.startsWith('data:')) continue
          const payload = line.slice(5).trim()
          if (!payload || payload === '[DONE]') continue
          try {
            events.push(JSON.parse(payload))
          } catch {
            /* ignore malformed */
          }
        }
      }
      if (events.some((event) => event.type === 'run.done' || event.type === 'run.error')) break
    }
    controller.abort()
  } catch {
    /* 超时当作结束 */
  } finally {
    clearTimeout(timer)
  }
  void runId
  return { status: 200, events }
}

async function checkStatic(options) {
  const health = await http(options, '/api/health')
  if (!health.ok) {
    record('必需', 'GET /api/health', false, 'HTTP ' + health.status + (health.error ? ' ' + health.error : ''))
    return false
  }
  requireFields('必需', 'GET /api/health', health.body, ['ok', 'version', 'engine', 'workspace'])

  const settings = await http(options, '/api/settings')
  if (requireFields('必需', 'GET /api/settings', settings.body, ['engine'])) {
    requireFields('必需', 'settings.engine 字段', settings.body.engine, ['provider', 'baseUrl', 'model', 'offlineMode'])
    const optional = ['agent', 'git', 'w3'].filter((key) => !settings.body[key])
    record('可选', 'settings 扩展区块', optional.length === 0, optional.length ? '缺 ' + optional.join(', ') + '（前端有默认值）' : 'ok')
  }

  const projects = await http(options, '/api/projects')
  const listOk = Array.isArray(projects.body && projects.body.projects)
  record('必需', 'GET /api/projects', projects.ok && listOk, listOk ? '返回 ' + projects.body.projects.length + ' 个项目' : '缺少 projects 数组')

  const w3 = await http(options, '/api/auth/w3/status')
  record('可选', 'GET /api/auth/w3/status', w3.ok, w3.ok ? 'ok' : 'HTTP ' + w3.status)

  const models = await http(options, '/api/models')
  const modelsOk = Boolean(models.body && Array.isArray(models.body.models))
  record('可选', 'GET /api/models', models.ok && modelsOk, modelsOk ? models.body.models.length + ' 个模型' : 'HTTP ' + models.status)
  return true
}

async function checkProjectFlow(options) {
  const created = await http(options, '/api/projects', {
    method: 'POST',
    body: JSON.stringify({
      name: '契约自检项目',
      sourceKind: 'page',
      sourceUrl: 'https://example.com/plan.html',
      targetVersion: '9.9.9',
      description: 'contract-check 创建，可安全删除',
    }),
  })
  const project = created.body
  const createdOk = created.ok && project && typeof project.id === 'string'
  record('必需', 'POST /api/projects', Boolean(createdOk), createdOk ? 'id=' + project.id : 'HTTP ' + created.status)
  if (!createdOk) return null
  requireFields('必需', '创建返回的 Project 字段', project, ['id', 'name', 'status', 'baseVersion', 'targetVersion', 'createdAt', 'workspace'])

  const one = await http(options, '/api/projects/' + project.id)
  record('必需', 'GET /api/projects/:id', one.ok && Boolean(one.body && one.body.id), one.ok ? 'ok' : 'HTTP ' + one.status)

  const patched = await http(options, '/api/projects/' + project.id, {
    method: 'PATCH',
    body: JSON.stringify({ description: 'contract-check touched' }),
  })
  record('必需', 'PATCH /api/projects/:id', patched.ok, patched.ok ? 'ok' : 'HTTP ' + patched.status)

  const started = await http(options, '/api/projects/' + project.id + '/run', {
    method: 'POST',
    body: JSON.stringify({ upgradeRequest: '补充说明文档', targetVersion: '9.9.9' }),
  })
  const runId = started.body && started.body.runId
  const startOk = started.ok && typeof runId === 'string'
  record('必需', 'POST /api/projects/:id/run', Boolean(startOk), startOk ? 'runId=' + runId : 'HTTP ' + started.status)
  if (!startOk) return project

  const steps = started.body.run && started.body.run.steps
  const stepsOk = Array.isArray(steps) && steps.length >= 5
  record('必需', 'run 创建时带 steps', Boolean(stepsOk), stepsOk ? steps.length + ' 步' : 'steps 缺失或过少（刷新后进度条会空）')

  const runs = await http(options, '/api/runs?projectId=' + project.id)
  const runsOk = Boolean(runs.body && Array.isArray(runs.body.runs))
  record('必需', 'GET /api/runs?projectId=', runs.ok && runsOk, runsOk ? runs.body.runs.length + ' 条' : 'HTTP ' + runs.status)

  const runOne = await http(options, '/api/runs/' + runId)
  record('必需', 'GET /api/runs/:id', runOne.ok && Boolean(runOne.body && runOne.body.id), runOne.ok ? 'ok' : 'HTTP ' + runOne.status)

  const sse = await readSse(options, runId, '/api/runs/' + runId + '/events?since=0', 90_000)
  const events = sse.events
  record('必需', 'GET /api/runs/:id/events（SSE）', events.length > 0, events.length + ' 个事件')
  if (events.length) {
    const seqs = events.map((event) => event.seq)
    const increasing = seqs.every((seq, index) => index === 0 || seq > seqs[index - 1])
    record('必需', 'seq 单调递增', increasing, increasing ? 'ok' : '出现了重复或倒退的 seq')
    const hasRunId = events.every((event) => typeof event.runId === 'string')
    record('必需', '事件都带 runId', hasRunId, hasRunId ? 'ok' : '有事件缺 runId')
    const hasTerminal = events.some((event) => event.type === 'run.done' || event.type === 'run.error')
    record('必需', '有终止事件 run.done / run.error', hasTerminal, hasTerminal ? 'ok' : '未在 90s 内收到终止事件')
    const hasStep = events.some((event) => event.type === 'step.status')
    record('必需', '有 step.status 事件', hasStep, hasStep ? 'ok' : '进度条不会动')
    const stepKeys = events
      .filter((event) => event.type === 'step.status')
      .map((event) => (event.data && event.data.key) || event.step)
    const expected = ['fetch', 'download', 'analyze', 'update', 'code', 'diff', 'finalize']
    const matched = expected.filter((key) => stepKeys.includes(key))
    record('必需', '7 个步骤 key', matched.length >= 5, '命中 ' + matched.join(',') )

    const persisted = await http(options, '/api/runs/' + runId)
    const runSteps = (persisted.body && persisted.body.steps) || []
    const doneSteps = runSteps.filter((step) => step.status && step.status !== 'pending')
    record('必需', '步骤状态写回 run 记录', doneSteps.length > 0, doneSteps.length + '/' + runSteps.length + ' 步已更新')
  }

  const documents = await http(options, '/api/projects/' + project.id + '/documents')
  if (requireFields('必需', 'GET /api/projects/:id/documents', documents.body, ['plan', 'update'])) {
    requireFields('必需', 'documents.plan 字段', documents.body.plan, ['content', 'exists'])
  }

  const diff = await http(options, '/api/projects/' + project.id + '/diff')
  if (requireFields('必需', 'GET /api/projects/:id/diff', diff.body, ['files', 'plan', 'stats'])) {
    const files = diff.body.files
    record('必需', 'diff.files 是数组', Array.isArray(files), Array.isArray(files) ? files.length + ' 个文件' : '不是数组')
    if (Array.isArray(files) && files.length) {
      const sample = files.find((file) => file.patch) || files[0]
      const fieldsOk = ['path', 'status', 'additions', 'deletions'].every((key) => sample[key] !== undefined)
      record('必需', 'diff.files[] 字段', fieldsOk, fieldsOk ? 'ok' : '缺 path/status/additions/deletions')
      const patchOk = typeof sample.patch === 'string'
      record('可选', 'diff patch 为统一差异文本', patchOk, patchOk ? (sample.patch.includes('@@') ? 'ok' : '缺 @@ 头，差异页可能空白') : '不是字符串')
    }
    requireFields('必需', 'diff.stats 字段', diff.body.stats, ['files', 'added', 'removed'])
  }

  const tree = await http(options, '/api/projects/' + project.id + '/tree?side=target')
  const treeOk = Boolean(tree.body && (tree.body.tree === null || typeof tree.body.tree === 'object'))
  record('必需', 'GET /api/projects/:id/tree', tree.ok && treeOk, tree.ok ? 'ok' : 'HTTP ' + tree.status)

  const firstFile = findFirstFile(tree.body && tree.body.tree)
  if (firstFile) {
    const file = await http(options, '/api/projects/' + project.id + '/file?side=target&path=' + encodeURIComponent(firstFile))
    const fileOk = file.ok && file.body && typeof file.body.content === 'string'
    record('必需', 'GET /api/projects/:id/file', Boolean(fileOk), fileOk ? firstFile + '（' + file.body.content.length + ' 字符）' : 'HTTP ' + file.status)
  } else {
    record('必需', 'GET /api/projects/:id/file', false, '树里没有文件，无法验证')
  }

  return project
}

function findFirstFile(node) {
  if (!node || typeof node !== 'object') return null
  if (node.type === 'file') return node.path
  const children = Array.isArray(node.children) ? node.children : []
  for (const child of children) {
    const found = findFirstFile(child)
    if (found) return found
  }
  return null
}

async function checkChat(options, project) {
  const chat = await http(options, '/api/projects/' + project.id + '/chat', {
    method: 'POST',
    body: JSON.stringify({ message: '这个项目现在有什么差异？', history: [] }),
  })
  const runId = chat.body && chat.body.runId
  const ok = chat.ok && typeof runId === 'string'
  record('必需', 'POST /api/projects/:id/chat', Boolean(ok), ok ? 'runId=' + runId : 'HTTP ' + chat.status)
  if (!ok) return

  const sse = await readSse(options, runId, '/api/runs/' + runId + '/events?since=0', 120_000)
  const events = sse.events
  const message = events.find((event) => event.type === 'chat.message')
  record('必需', 'chat.message 事件', Boolean(message), message ? 'ok' : '对话气泡会一直「生成中」')
  const deltas = events.filter((event) => event.type === 'chat.delta')
  record('可选', 'chat.delta 流式增量', deltas.length > 0, deltas.length + ' 块')
  const reasoning = events.filter((event) => event.type === 'chat.reasoning')
  record('可选', 'chat.reasoning 思考过程', reasoning.length > 0, reasoning.length + ' 段')
  const tools = events.filter((event) => event.type === 'chat.tool')
  record('可选', 'chat.tool 工具调用', tools.length > 0, tools.length + ' 次')
  if (message && message.data && message.data.proposal) {
    const proposal = message.data.proposal
    const fieldsOk = ['id', 'summary'].every((key) => proposal[key] !== undefined) && Array.isArray(proposal.edits)
    record('必需', 'chat.message.proposal 结构', fieldsOk, fieldsOk ? proposal.edits.length + ' 个文件' : '缺 id/summary/edits')
  }
}

async function main() {
  let options
  try {
    options = parseArgs(process.argv.slice(2))
  } catch (error) {
    console.error(String((error && error.message) || error))
    process.exit(2)
  }
  if (options.help) {
    console.log('node scripts/contract-check.mjs --api http://host:port [--read-only] [--json] [--keep]')
    return
  }

  console.log('契约自检 → ' + options.api + (options.readOnly ? '（只读）' : ''))
  const alive = await checkStatic(options)
  if (!alive) {
    console.error('\n后端不可用：先确认地址/端口/CORS，再看 GET /api/health。')
    process.exit(2)
  }

  let project = null
  if (!options.readOnly) {
    project = await checkProjectFlow(options)
    if (project) await checkChat(options, project)
    if (project && !options.keep) {
      const removed = await http(options, '/api/projects/' + project.id, { method: 'DELETE' })
      record('清理', 'DELETE /api/projects/:id', removed.ok, removed.ok ? 'ok' : 'HTTP ' + removed.status)
    }
  }
  void sleep

  const required = results.filter((item) => item.group === '必需')
  const failedRequired = required.filter((item) => !item.ok)
  const optionalFailed = results.filter((item) => item.group === '可选' && !item.ok)

  if (options.json) {
    console.log(JSON.stringify({ api: options.api, results, failed: failedRequired.length }, null, 2))
  } else {
    console.log('')
    for (const item of results) {
      const mark = item.ok ? '✓' : item.group === '可选' ? '·' : '✗'
      console.log('  ' + mark + ' [' + item.group + '] ' + item.name + (item.detail ? '  → ' + item.detail : ''))
    }
    console.log('')
    console.log('必需项：' + (required.length - failedRequired.length) + '/' + required.length + ' 通过；可选项缺失 ' + optionalFailed.length + ' 项（不影响主流程）')
  }

  if (failedRequired.length) {
    console.error('\n待修：' + failedRequired.map((item) => item.name).join('、'))
    process.exit(1)
  }
  process.exit(0)
}

main()
