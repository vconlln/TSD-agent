#!/usr/bin/env node
/**
 * 安装包构建入口（内网定制用）。
 *
 * 与 npm run dist:* 的区别：这里可以方便地把「内网需要的东西」塞进安装包——
 * 额外的 Python 依赖、额外资源文件、出厂默认配置（内网网关地址 / 模型名）。
 *
 * 用法：
 *   node scripts/build-installer.mjs --target win
 *   node scripts/build-installer.mjs --target win \
 *     --extra-pip "internal-sdk==1.2.0" \
 *     --add assets/internal-ca.crt:ca/internal-ca.crt \
 *     --defaults scripts/presets/intranet.json \
 *     --version 1.1.0 --verify
 *
 * 参数：
 *   --target win|linux|dir    打包目标（默认 win）
 *   --version x.y.z          覆盖 package.json 版本（构建后自动还原）
 *   --extra-pip "a b c"      额外 pip 依赖（打进后端）
 *   --requirements file.txt  额外依赖清单文件
 *   --add src:dest           额外文件/目录 → resources/dest（可重复）
 *   --defaults file.json     出厂默认配置 → resources/defaults.json（首次启动生效）
 *   --skip-backend           复用已有 backend-dist/tsd-server
 *   --skip-renderer          复用已有 dist/
 *   --verify                 构建后跑打包产物冒烟自检（Linux 本地；Windows 走 Wine）
 *   --out dir                产物目录（默认 release）
 */
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const IS_WIN = process.platform === 'win32'

function parseArgs(argv) {
  const options = {
    target: 'win',
    version: null,
    extraPip: [],
    requirements: null,
    add: [],
    defaults: null,
    skipBackend: false,
    skipRenderer: false,
    verify: false,
    out: 'release',
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const next = () => {
      const value = argv[i + 1]
      if (!value || value.startsWith('--')) throw new Error(arg + ' 需要一个值')
      i += 1
      return value
    }
    switch (arg) {
      case '--target': options.target = next(); break
      case '--version': options.version = next(); break
      case '--extra-pip': options.extraPip.push(...next().split(/\s+/).filter(Boolean)); break
      case '--requirements': options.requirements = next(); break
      case '--add': options.add.push(next()); break
      case '--defaults': options.defaults = next(); break
      case '--skip-backend': options.skipBackend = true; break
      case '--skip-renderer': options.skipRenderer = true; break
      case '--verify': options.verify = true; break
      case '--out': options.out = next(); break
      case '--help': case '-h': options.help = true; break
      default: throw new Error('未知参数：' + arg)
    }
  }
  return options
}

/** 构建期统一的环境：镜像 / 缓存 / Wine 前缀（都已 gitignore 在 build-tools 下） */
function buildEnv() {
  const tools = path.join(ROOT, 'build-tools')
  const env = {
    TMPDIR: process.env.TMPDIR || path.join(tools, 'tmp'),
    XDG_CACHE_HOME: process.env.XDG_CACHE_HOME || path.join(tools, 'cache'),
    ELECTRON_CACHE: process.env.ELECTRON_CACHE || path.join(tools, 'cache', 'electron'),
    ELECTRON_BUILDER_CACHE: process.env.ELECTRON_BUILDER_CACHE || path.join(tools, 'cache', 'electron-builder'),
    WINEPREFIX: process.env.WINEPREFIX || path.join(tools, 'wineprefix'),
    WINEDEBUG: process.env.WINEDEBUG || '-all',
  }
  // 国内网络默认走镜像；能直连 GitHub 时可以用环境变量覆盖成空字符串
  if (process.env.ELECTRON_MIRROR === undefined) {
    env.ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/'
  }
  if (process.env.ELECTRON_BUILDER_BINARIES_MIRROR === undefined) {
    env.ELECTRON_BUILDER_BINARIES_MIRROR = 'https://npmmirror.com/mirrors/electron-builder-binaries/'
  }
  if (!process.env.ELECTRON_BUILDER_7ZIP_PATH && existsSync('/usr/bin/7za')) {
    env.ELECTRON_BUILDER_7ZIP_PATH = '/usr/bin/7za'
  }
  mkdirSync(env.TMPDIR, { recursive: true })
  return env
}

function run(command, args, { cwd = ROOT, env = {}, label } = {}) {
  console.log('\n\u25b8 ' + (label || command + ' ' + args.join(' ')))
  const result = spawnSync(command, args, {
    cwd,
    stdio: 'inherit',
    env: { ...process.env, ...buildEnv(), ...env },
    shell: IS_WIN && (command === 'npm' || command === 'npx'),
  })
  if (result.status !== 0) throw new Error((label || command) + ' 失败（退出码 ' + result.status + '）')
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'))
}

function prepareBundledResources(options) {
  const bundled = path.join(ROOT, 'build', 'bundled')
  rmSync(bundled, { recursive: true, force: true })
  mkdirSync(bundled, { recursive: true })
  let hasContent = false

  if (options.defaults) {
    const source = path.resolve(ROOT, options.defaults)
    if (!existsSync(source)) throw new Error('找不到默认配置文件：' + options.defaults)
    writeFileSync(path.join(bundled, 'defaults.json'), readFileSync(source))
    console.log('  出厂默认配置 → resources/defaults.json（' + path.relative(ROOT, source) + '）')
    hasContent = true
  }

  for (const item of options.add) {
    const [rawSource, rawDest] = item.split(':')
    if (!rawSource || !rawDest) throw new Error('--add 需要 src:dest 形式，收到 ' + item)
    const source = path.resolve(ROOT, rawSource)
    if (!existsSync(source)) throw new Error('找不到要打包的资源：' + rawSource)
    const dest = path.join(bundled, rawDest.replace(/^[/\\]+/, ''))
    mkdirSync(path.dirname(dest), { recursive: true })
    cpSync(source, dest, { recursive: true })
    console.log('  额外资源 → resources/' + rawDest)
    hasContent = true
  }

  return hasContent ? bundled : null
}

function collectExtraRequirements(options) {
  const items = [...options.extraPip]
  if (options.requirements) {
    const file = path.resolve(ROOT, options.requirements)
    if (!existsSync(file)) throw new Error('找不到依赖清单：' + options.requirements)
    for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      items.push(trimmed)
    }
  }
  return items
}

function buildBackend(options, extraPip) {
  if (options.skipBackend) {
    if (!existsSync(path.join(ROOT, 'backend-dist', 'tsd-server'))) {
      throw new Error('--skip-backend 需要先有 backend-dist/tsd-server')
    }
    console.log('\n\u25b8 复用已有后端产物 backend-dist/tsd-server')
    return
  }
  const crossBuild = options.target === 'win' && !IS_WIN
  if (crossBuild) {
    run('bash', ['scripts/build-windows-on-linux.sh', '--backend-only'], {
      env: { EXTRA_REQUIREMENTS: extraPip.join(' ') },
      label: '交叉构建 Windows 后端（Wine + PyInstaller）',
    })
    return
  }
  if (extraPip.length) {
    run('node', ['scripts/py.mjs', '-m', 'pip', 'install', '-q', ...extraPip], { label: '安装额外依赖' })
  }
  run('node', ['scripts/py.mjs', '-m', 'PyInstaller', '--noconfirm', '--clean', 'server/tsd_server.spec'], {
    label: '打包 Python 后端（PyInstaller）',
  })
  const produced = path.join(ROOT, 'server', 'dist', 'tsd-server')
  const target = path.join(ROOT, 'backend-dist', 'tsd-server')
  rmSync(target, { recursive: true, force: true })
  mkdirSync(path.dirname(target), { recursive: true })
  cpSync(produced, target, { recursive: true })
  console.log('  后端产物 → backend-dist/tsd-server')
}

function writeConfig(bundledDir) {
  const generated = path.join(ROOT, 'build', 'electron-builder.generated.yml')
  const lines = ['extends: ./electron-builder.yml', 'extraResources:', '  - from: backend-dist', '    to: backend']
  if (bundledDir) {
    lines.push('  - from: ' + path.relative(ROOT, bundledDir).replace(/\\/g, '/'), '    to: .')
  }
  mkdirSync(path.dirname(generated), { recursive: true })
  writeFileSync(generated, lines.join('\n') + '\n')
  return generated
}

function verifyArtifact(options, outDir) {
  console.log('\n\u25b8 冒烟自检（渲染进程 + 内置后端）')
  if (options.target === 'linux' || options.target === 'dir') {
    const candidates = ['linux-unpacked', 'win-unpacked', 'mac', 'mac-arm64']
    const dir = candidates.map((name) => path.join(outDir, name)).find((full) => existsSync(full))
    if (!dir) {
      console.warn('  找不到 unpacked 目录，跳过冒烟')
      return
    }
    run('node', ['scripts/verify-packaged-app.mjs', '--dir', path.relative(ROOT, dir)], {
      label: 'verify-packaged-app ' + path.basename(dir),
    })
    return
  }
  // Windows 产物：在 Linux 上借 Wine 跑一次
  const appDir = path.join(outDir, 'win-unpacked')
  if (!existsSync(appDir)) {
    console.warn('  找不到 win-unpacked，跳过冒烟')
    return
  }
  if (IS_WIN) {
    run('node', ['scripts/verify-packaged-app.mjs', '--dir', path.relative(ROOT, appDir)], {
      label: 'verify-packaged-app win-unpacked',
    })
    return
  }
  const smoke = path.join(ROOT, 'build-tools', 'smoke.json')
  rmSync(smoke, { force: true })
  const exe = readdirSync(appDir).find((entry) => entry.endsWith('.exe'))
  if (!exe) {
    console.warn('  找不到主程序 exe，跳过冒烟')
    return
  }
  const wineSmokePath = 'Z:' + smoke.replace(/\//g, '\\')
  let status = null
  // 刚打包完 wineserver 还在收尾，第一次启动偶尔失败：重试一次更稳
  for (let attempt = 0; attempt < 2 && !existsSync(smoke); attempt += 1) {
    if (attempt > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 4000)
    const child = spawnSync('wine', [exe, '--no-sandbox', '--disable-gpu', '--ozone-platform=headless'], {
      cwd: appDir,
      stdio: 'ignore',
      env: { ...process.env, ...buildEnv(), TSD_SMOKE_OUTPUT: wineSmokePath, WINEDEBUG: '-all' },
      timeout: 240_000,
    })
    status = child.status
    if (child.error) console.warn('  Wine 启动失败：' + child.error.message)
  }
  if (!existsSync(smoke)) {
    console.warn('  未拿到冒烟结果（Wine 下 Electron 需要显示服务）；产物本身已生成')
    return
  }
  const result = { status }
  const data = JSON.parse(readFileSync(smoke, 'utf8'))
  if (!data.ok) throw new Error('冒烟失败：' + JSON.stringify(data).slice(0, 400))
  console.log('  冒烟通过：' + data.backendUrl + ' / ' + data.health.platform + ' / v' + data.health.version +
    (result.status === 0 ? '' : '（进程退出码 ' + result.status + '）'))
}

function main() {
  let options
  try {
    options = parseArgs(process.argv.slice(2))
  } catch (error) {
    console.error(String(error.message || error))
    process.exit(2)
  }
  if (options.help) {
    console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0])
    return
  }

  const pkgFile = path.join(ROOT, 'package.json')
  const originalPkg = readFileSync(pkgFile, 'utf8')
  const pkg = JSON.parse(originalPkg)

  try {
    console.log('==> 1/5 准备内网定制资源')
    const bundledDir = prepareBundledResources(options)
    if (!bundledDir) console.log('  无额外资源')

    console.log('==> 2/5 准备 Python 后端')
    buildBackend(options, collectExtraRequirements(options))

    console.log('==> 3/5 构建前端')
    if (options.skipRenderer) {
      console.log('  跳过（--skip-renderer）')
    } else {
      run('npm', ['run', 'build'], { label: '构建渲染进程与主进程' })
    }

    console.log('==> 4/5 打包安装包')
    if (options.version) {
      pkg.version = options.version
      writeFileSync(pkgFile, JSON.stringify(pkg, null, 2) + '\n')
      console.log('  版本号覆盖为 ' + options.version)
    }
    const config = writeConfig(bundledDir)
    const outDir = path.resolve(ROOT, options.out)
    const targetArgs =
      options.target === 'win'
        ? ['--win', 'nsis', '--x64']
        : options.target === 'linux'
          ? ['--linux', 'AppImage', '--x64']
          : ['--dir']
    run('npx', [
      'electron-builder',
      ...targetArgs,
      '--config',
      config,
      '--publish',
      'never',
      '-c.directories.output=' + outDir,
    ], { label: 'electron-builder ' + options.target })

    if (options.verify) verifyArtifact(options, outDir)

    console.log('==> 5/5 汇总')
    const artifacts = []
    if (existsSync(outDir)) {
      for (const entry of readdirSync(outDir)) {
        const full = path.join(outDir, entry)
        if (!statSync(full).isFile()) continue
        if (!/\.(exe|AppImage|dmg|blockmap|yml)$/.test(entry)) continue
        artifacts.push({ file: full, size: statSync(full).size })
      }
    }
    for (const item of artifacts) {
      const mb = (item.size / 1048576).toFixed(1) + ' MB'
      console.log('  产物：' + path.relative(ROOT, item.file) + '（' + mb + '）')
    }
    if (!artifacts.length) console.log('  （没有匹配的安装包，检查 --target 与构建日志）')
    console.log('\n构建完成。产物目录：' + path.relative(ROOT, outDir))
  } finally {
    if (options && options.version) writeFileSync(pkgFile, originalPkg)
  }
}

main()
