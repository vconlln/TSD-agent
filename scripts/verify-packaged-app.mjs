/**
 * 打包产物自检：启动 release 下的未打包应用，等待它报告渲染进程与内置后端都正常。
 *
 *   node scripts/verify-packaged-app.mjs                  # 自动探测平台目录
 *   node scripts/verify-packaged-app.mjs --dir release/win-unpacked
 *
 * 应用侧通过 TSD_SMOKE_OUTPUT 环境变量进入自检模式（见 electron/main.ts），
 * 结束时写出 JSON 结果并以 0/1 退出。
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, "..")

function parseArgs() {
  const args = process.argv.slice(2)
  const dirIndex = args.indexOf("--dir")
  return { dir: dirIndex >= 0 ? args[dirIndex + 1] : undefined, keep: args.includes("--keep") }
}

function platformCandidates() {
  if (process.platform === "win32") {
    return ["release/win-unpacked/TSD Agent.exe", "release/win-unpacked/TSD-Agent.exe"]
  }
  if (process.platform === "darwin") {
    return [
      "release/mac-arm64/TSD Agent.app/Contents/MacOS/TSD Agent",
      "release/mac/TSD Agent.app/Contents/MacOS/TSD Agent",
    ]
  }
  return ["release/linux-unpacked/tsd-agent", "release/linux-unpacked/TSD Agent"]
}

function locateBinary(explicitDir) {
  const candidates = explicitDir
    ? [
        path.join(explicitDir, "TSD Agent.exe"),
        path.join(explicitDir, "TSD Agent"),
        path.join(explicitDir, "tsd-agent"),
      ]
    : platformCandidates().map((relative) => path.join(root, relative))
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

const { dir, keep } = parseArgs()
const binary = locateBinary(dir)
if (!binary) {
  console.error("[verify-packaged] 未找到打包产物，请先运行 npm run dist:win / dist:dir / dist:linux")
  process.exit(2)
}

const workDir = mkdtempSync(path.join(tmpdir(), "tsd-smoke-"))
const outputPath = path.join(workDir, "smoke.json")
const profileDir = path.join(workDir, "profile")
mkdirSync(profileDir, { recursive: true })

const timeoutMs = Number(process.env.TSD_SMOKE_TIMEOUT_MS ?? 150000)
const headlessLinux =
  process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY
const args = [
  "--user-data-dir=" + profileDir,
  "--disable-gpu",
  ...(process.platform === "linux" ? ["--no-sandbox"] : []),
  // 无显示环境下用 headless ozone 后端，便于 CI / 远端机器自检
  ...(headlessLinux ? ["--ozone-platform=headless"] : []),
]

console.log("[verify-packaged] launching", binary)
const child = spawn(binary, args, {
  env: { ...process.env, TSD_SMOKE_OUTPUT: outputPath, TSD_SMOKE: "1" },
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
})

let stdout = ""
let stderr = ""
child.stdout?.on("data", (chunk) => (stdout += chunk.toString()))
child.stderr?.on("data", (chunk) => (stderr += chunk.toString()))

const timer = setTimeout(() => {
  console.error("[verify-packaged] 超时（" + timeoutMs + "ms），终止应用")
  child.kill("SIGKILL")
}, timeoutMs)

child.on("exit", (code, signal) => {
  clearTimeout(timer)
  let report = null
  try {
    report = JSON.parse(readFileSync(outputPath, "utf8"))
  } catch {
    report = null
  }

  const ok = Boolean(report && report.ok) && code === 0
  if (ok) {
    console.log("[verify-packaged] OK")
    console.log(JSON.stringify(report, null, 2))
  } else {
    console.error("[verify-packaged] FAILED (exit=" + String(code ?? signal) + ")")
    if (report) console.error(JSON.stringify(report, null, 2))
    if (stdout.trim()) console.error("--- stdout ---\n" + stdout.slice(-4000))
    if (stderr.trim()) console.error("--- stderr ---\n" + stderr.slice(-4000))
  }

  if (!keep) rmSync(workDir, { recursive: true, force: true })
  process.exit(ok ? 0 : 1)
})
