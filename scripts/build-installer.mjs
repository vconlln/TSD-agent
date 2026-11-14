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
import {
  closeSync,
  cpSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
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
    signCmd: process.env.TSD_SIGN_CMD || '',
    requireSignature: false,
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
      case '--sign-cmd': options.signCmd = next(); break
      case '--require-signature': options.requireSignature = true; break
      case '--help': case '-h': options.help = true; break
      default: throw new Error('未知参数：' + arg)
    }
  }
  return options
}

/**
 * electron-builder 自带的 Linux osslsigncode 是 2020 年编译的，链接 libcrypto.so.1.1；
 * 新发行版只剩 OpenSSL 3，直接跑会 `error while loading shared libraries`。
 * 这里找一找系统里有没有 1.1（很多机器被 Steam / 旧运行时带着），有就临时挂上。
 */
function libcrypto11Dir() {
  const probe = spawnSync('bash', ['-c', 'ldconfig -p 2>/dev/null | grep -c "libcrypto\\.so\\.1\\.1" || true'])
  if (probe.stdout && Number(String(probe.stdout).trim()) > 0) return null // 系统自带，不用管
  const home = process.env.HOME || ''
  const candidates = [
    '/usr/lib',
    '/usr/lib64',
    '/usr/lib/x86_64-linux-gnu',
    '/lib/x86_64-linux-gnu',
    path.join(home, '.local/share/Steam/steamrt64'),
  ]
  const found = []
  const walk = (dir, depth) => {
    if (depth > 6 || found.length) return
    let entries
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    if (entries.includes('libcrypto.so.1.1')) {
      found.push(dir)
      return
    }
    for (const entry of entries) {
      if (entry.startsWith('.')) continue
      const full = path.join(dir, entry)
      try {
        if (statSync(full).isDirectory()) walk(full, depth + 1)
      } catch {
        /* 跳过 */
      }
    }
  }
  for (const dir of candidates) walk(dir, 0)
  return found[0] || null
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
  // 只在真的要签名时才需要（electron-builder 的 osslsigncode 依赖 OpenSSL 1.1）
  if ((process.env.WIN_CSC_LINK || process.env.CSC_LINK) && process.platform !== 'win32') {
    const dir = libcrypto11Dir()
    if (dir) {
      env.LD_LIBRARY_PATH = [dir, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':')
    }
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

/**
 * 读 PE 文件的 Authenticode 签名（只读头部，不解析证书链，跨平台可用）。
 * 返回 { signed, size, offset }，用于构建后自检「签上了没有」。
 */
function peSignature(file) {
  try {
    const fd = openSync(file, 'r')
    try {
      const head = Buffer.alloc(4096)
      readSync(fd, head, 0, head.length, 0)
      if (head.toString('ascii', 0, 2) !== 'MZ') return { signed: false, size: 0 }
      const peOffset = head.readUInt32LE(0x3c)
      if (head.toString('ascii', peOffset, peOffset + 4) !== 'PE\0\0') return { signed: false, size: 0 }
      const coff = peOffset + 4
      const optionalHeaderSize = head.readUInt16LE(coff + 16)
      const optional = coff + 20
      const magic = head.readUInt16LE(optional)
      // data directory 从 optional header + 96 (PE32) / +112 (PE32+) 开始，第 5 项是 Certificate Table
      const dataDir = optional + (magic === 0x20b ? 112 : 96)
      const certEntry = dataDir + 4 * 8
      if (certEntry + 8 > head.length) return { signed: false, size: 0 }
      const offset = head.readUInt32LE(certEntry)
      const size = head.readUInt32LE(certEntry + 4)
      return { signed: size > 0, size, offset }
    } finally {
      closeSync(fd)
    }
  } catch {
    return { signed: false, size: 0 }
  }
}

/** 外部签名命令模板：{file} 会被替换成待签文件路径 */
function signWithCommand(template, file) {
  const command = template.replaceAll('{file}', file)
  console.log('\n▸ 签名 ' + path.relative(ROOT, file))
  console.log('  ' + command)
  const result = spawnSync(command, { shell: true, stdio: 'inherit', env: { ...process.env, ...buildEnv() } })
  if (result.status !== 0) throw new Error('签名失败（退出码 ' + result.status + '）：' + command)
  const info = peSignature(file)
  if (!info.signed) throw new Error('签名命令执行完了，但文件里没有 Authenticode 签名：' + file)
  console.log('  ✓ 已签名（' + Math.round(info.size / 1024) + ' KB 签名块）')
}

/** 说明当前处于哪种签名模式（只打印，真正的签名交给对应工具） */
function describeSigning(options) {
  const pfx = process.env.WIN_CSC_LINK || process.env.CSC_LINK
  if (pfx) {
    const name = pfx.startsWith('data:') ? '(base64)' : pfx
    return 'PFX 证书（' + name + '）→ electron-builder 内置 signtool'
  }
  if (process.env.AZURE_SIGN_ENDPOINT) {
    return 'Azure Trusted Signing（需 Windows 上的 Invoke-TrustedSigning 模块）'
  }
  if (options.signCmd) return '外部命令：' + options.signCmd
  if (options.requireSignature) {
    throw new Error('--require-signature 需要证书：设置 WIN_CSC_LINK/WIN_CSC_KEY_PASSWORD 或传 --sign-cmd')
  }
  return '未配置（产出的 exe 是未签名的，SmartScreen 会提示）'
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

/**
 * 把 Rust 后端二进制（含 prompts/）放进 backend-dist，打包后落点是 resources/backend/。
 * 找不到就跳过——supervisor 会自动回退到 Python 后端，不会让安装包变成不能启动。
 */
function stageRustBackend(options) {
  const isWin = options.target === 'win'
  const name = isWin ? 'tsd-server-rs.exe' : 'tsd-server-rs'
  const candidates = isWin
    ? [
        path.join(ROOT, 'rust-backend', 'target', 'x86_64-pc-windows-msvc', 'release', name),
        path.join(ROOT, 'rust-backend', 'target', 'x86_64-pc-windows-gnu', 'release', name),
      ]
    : [path.join(ROOT, 'rust-backend', 'target', 'release', name)]
  const binary = candidates.find((candidate) => existsSync(candidate))
  const targetDir = path.join(ROOT, 'backend-dist', 'tsd-server-rs')
  if (!binary) {
    // 关键：清掉上一次为别的平台暂存的二进制，否则会把 Linux ELF 打进 Windows 包
    rmSync(targetDir, { recursive: true, force: true })
    console.log('\n▸ 未找到 Rust 后端二进制（' + candidates[0].replace(ROOT + path.sep, '') + '）')
    console.log('  安装包将使用 Python 后端；想用 Rust：npm run rust:build（交叉到 Windows 需要 mingw + rustup target）')
    return false
  }
  rmSync(targetDir, { recursive: true, force: true })
  mkdirSync(targetDir, { recursive: true })
  cpSync(binary, path.join(targetDir, name))
  const prompts = path.join(ROOT, 'rust-backend', 'prompts')
  if (existsSync(prompts)) {
    cpSync(prompts, path.join(targetDir, 'prompts'), { recursive: true })
  }
  const size = Math.round(statSync(binary).size / 1024 / 1024 * 10) / 10
  console.log('\n▸ Rust 后端已就位 → backend-dist/tsd-server-rs（' + size + ' MB，含 prompts）')
  return true
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

  options.startedAt = Date.now()
  const pkgFile = path.join(ROOT, 'package.json')
  const originalPkg = readFileSync(pkgFile, 'utf8')
  const pkg = JSON.parse(originalPkg)

  try {
    console.log('==> 1/5 准备内网定制资源')
    const bundledDir = prepareBundledResources(options)
    if (!bundledDir) console.log('  无额外资源')

    console.log('==> 2/5 准备后端（优先 Rust，兜底 Python）')
    buildBackend(options, collectExtraRequirements(options))

    stageRustBackend(options)

    console.log('  签名模式：' + describeSigning(options))
    if (options.signCmd) {
      // 内置后端是 extraResources，electron-builder 不会替它签名
      for (const candidate of [
        path.join(ROOT, 'backend-dist', 'tsd-server', 'tsd-server.exe'),
        path.join(ROOT, 'backend-dist', 'tsd-server-rs', 'tsd-server-rs.exe'),
      ]) {
        if (existsSync(candidate)) signWithCommand(options.signCmd, candidate)
      }
    }

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

    // 产物签名：只处理本次构建新生成的 exe（release 里常有历史版本，不能一起校验）
    const buildStartedAt = options.startedAt
    const installers = readdirSync(outDir)
      .filter((name) => /\.exe$/i.test(name) && !name.includes('uninstaller'))
      .map((name) => path.join(outDir, name))
      .filter((file) => {
        try {
          return statSync(file).mtimeMs >= buildStartedAt - 5000
        } catch {
          return false
        }
      })
    if (options.signCmd) {
      for (const file of installers) signWithCommand(options.signCmd, file)
    }
    for (const file of installers) {
      const info = peSignature(file)
      const mark = info.signed ? '✓ 已签名' : '· 未签名'
      console.log('  ' + mark + '：' + path.basename(file) + (info.signed ? '（' + Math.round(info.size / 1024) + ' KB）' : ''))
      if (options.requireSignature && !info.signed) {
        throw new Error('要求签名但产物未签名：' + path.basename(file))
      }
    }

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
