#!/usr/bin/env node
// 统一选择「装了后端依赖」的 Python 解释器：优先仓库内的 .venv，其次 PATH 里的 python。
// 这样 npm scripts 在开发机（.venv）和 CI（全局 python）上都能直接跑通。
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const candidates = [
  path.join(root, '.venv', 'bin', 'python'),
  path.join(root, '.venv', 'Scripts', 'python.exe'),
  path.join(root, 'venv', 'bin', 'python'),
  path.join(root, 'venv', 'Scripts', 'python.exe'),
  'python3',
  'python',
]

const args = process.argv.slice(2)
for (const candidate of candidates) {
  const isPath = candidate.includes(path.sep)
  if (isPath && !existsSync(candidate)) continue
  const result = spawnSync(candidate, args, { stdio: 'inherit', env: process.env })
  if (result.error && result.error.code === 'ENOENT') continue
  process.exit(result.status ?? 1)
}

console.error('找不到可用的 Python。请先创建 .venv 并安装依赖：')
console.error('  python -m venv .venv && .venv/bin/pip install -r server/requirements.txt')
process.exit(1)
