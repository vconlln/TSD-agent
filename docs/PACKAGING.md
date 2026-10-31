# 打包指南（Windows exe）

目标产物：`TSD-Agent-Setup-1.0.0.exe` —— NSIS 安装包，内置 Python 后端，
安装后用户**不需要**安装 Python 或 Node。

---

## 0. 原理

```
electron-builder
├── dist/renderer        前端静态资源（Vite 产物，打进 asar）
├── dist/main            Electron 主进程 + preload（esbuild 产物）
├── node_modules/electron Electron 运行时
└── resources/backend/   ← extraResources：PyInstaller 打出来的 Python 后端
```

主进程启动时优先使用 `resources/backend/tsd-server/tsd-server.exe`；
找不到才回退到系统 Python。

---

## 1. 拿到 exe 的最快路径（GitHub Actions，零本地环境）

GitHub Actions 只识别 `.github/workflows/` 下的文件，而本仓库的推送 token 缺少
`workflow` 作用域，因此工作流先放在 `ci/` 作为模板，**安装一次**即可。

### 方式 A：命令行（30 秒）

```bash
gh auth refresh -s workflow          # 授予 workflow 权限（浏览器确认一次）
bash scripts/install-workflows.sh    # 复制 ci/*.yml → .github/workflows/
git add .github/workflows
git commit -m "ci: enable GitHub Actions"
git push
```

### 方式 B：网页（无需命令行）

1. 打开 <https://github.com/vconlln/TSD-agent>；
2. **Add file → Create new file**，文件名填 `.github/workflows/build-windows.yml`；
3. 把 `ci/build-windows.yml` 的内容整段粘贴进去 → **Commit changes**；
4. （可选）同样方式添加 `ci/ci.yml`、`ci/build-linux.yml`。

### 触发构建

- 打开 **Actions → Build Windows Installer → Run workflow**；
- 或推一个 tag：`git tag v1.0.0 && git push origin v1.0.0`（会自动创建 Release 并附上 exe）；
- 约 8–12 分钟后，在 run 的 **Artifacts** 下载 `TSD-Agent-Windows-Installer`，
  解压即得 `TSD-Agent-Setup-1.0.0.exe`。

工作流内容：

- `workflow_dispatch`：手动触发
- push 到 `main`：构建并上传 artifact
- push tag `v*`：构建 + 创建 GitHub Release 并附上 exe

步骤：pip 依赖 → `PyInstaller` → 拷贝到 `backend-dist` → `npm ci` →
`typecheck` → `vite build` → `electron-builder --win nsis`。

下载位置：Actions → 对应 run → Artifacts → `TSD-Agent-Windows-Installer`。

---

## 2. Windows 本地构建

前置：Node 18+、Python 3.10+、Git。

> 国内网络下 electron-builder 首次构建需要下载 Electron 与 7zip 工具集，
> 建议先设置镜像（PowerShell）：
>
> ```powershell
> $env:ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
> $env:ELECTRON_BUILDER_BINARIES_MIRROR="https://npmmirror.com/mirrors/electron-builder-binaries/"
> ```
>
> 下载过的产物会缓存在 `%LOCALAPPDATA%\electron\Cache` 与
> `%LOCALAPPDATA%\electron-builder\Cache`，后续构建直接复用。

```powershell
git clone https://github.com/vconlln/TSD-agent.git
cd TSD-agent

# 1) Python 后端
python -m pip install --upgrade pip
python -m pip install -r server/requirements.txt pyinstaller
cd server
python -m PyInstaller --noconfirm tsd_server.spec
cd ..

# 2) 放到打包资源目录
New-Item -ItemType Directory -Force backend-dist | Out-Null
Copy-Item -Recurse -Force server\dist\tsd-server backend-dist\tsd-server

# 3) 前端依赖 + 构建
npm ci
npm run typecheck
npm run build

# 4) 生成安装包
npm run dist:win
# 产物：release\TSD-Agent-Setup-1.0.0.exe
```

> 想先要免安装版：`npm run dist:win:portable` 或 `npm run dist:dir`
> （产物在 `release/win-unpacked/`）。

### 常见问题

| 现象 | 处理 |
| --- | --- |
| `PyInstaller` 报缺 hiddenimports | 已在 `server/tsd_server.spec` 用 `collect_submodules('uvicorn')` 覆盖；自定义依赖请补到 spec |
| 安装包很大（>200MB） | 正常：Electron + Python 运行时。onedir 已比 onefile 小且启动快 |
| 启动后提示「无法连接后端」 | 打开设置看后端状态与日志尾部；确认 `resources/backend/tsd-server/tsd-server.exe` 存在；也可在设置里指定 `pythonPath` |
| 杀毒软件误报 | PyInstaller 产物常见误报，需自行做代码签名（`win.signtoolOptions` 可配置证书） |
| 用户机器没有 WebView2 | 不受影响：Electron 自带 Chromium |

---

## 3. 让后端跟随你自己的服务

如果不想内置 Python：

1. 打包时**跳过** PyInstaller 步骤，`backend-dist` 留空；
2. 首次启动后在「设置 → 后端服务」切换为 **外部后端**，填地址；
3. 你的服务需实现 `docs/API.md` 并允许 CORS。

或保留内置模式，只把 `pythonPath` 指到你的解释器、入口仍为 `server/main.py`。

---

## 4. macOS / Linux

```bash
# Linux AppImage
npm run dist:linux      # release/TSD Agent-1.0.0.AppImage

# macOS dmg（需在 macOS 上执行）
npm run dist:mac
```

CI 里同样有 `ci/build-linux.yml`（安装方式同上）。

---

## 5. 安装向导的品牌化

安装包使用 **assisted（非一键）** NSIS 向导：欢迎页 → 安装模式 → 选择目录 → 安装 → 完成。

| 资源 | 生成方式 | 作用 |
| --- | --- | --- |
| `build/icon.png` / `icon.ico` | `npm run icon` | 应用图标 + 安装器图标 |
| `build/installerSidebar.bmp` | `npm run assets:installer` | 欢迎页/完成页左侧 164×314 竖图 |
| `build/installerHeader.bmp` | `npm run assets:installer` | 目录页/安装页顶部 150×57 横图 |
| `build/installer.nsh` | 手写 | 中文欢迎页/完成页文案（`customWelcomePage` 宏） |

`electron-builder.yml` 中相关配置：

```yaml
nsis:
  oneClick: false
  perMachine: false
  allowToChangeInstallationDirectory: true   # 允许自定义安装目录
  createDesktopShortcut: always
  installerSidebar: build/installerSidebar.bmp
  installerHeader: build/installerHeader.bmp
  include: build/installer.nsh
  installerLanguages: [zh_CN]                # 中文向导
  runAfterFinish: true                       # 完成后可直接启动
```

> NSIS 以 `-INPUTCHARSET UTF8` 编译，因此 `.nsh` 里可以直接写中文。

## 6. 打包产物自检

```bash
npm run verify:package                          # 自动探测 release/<platform>-unpacked
node scripts/verify-packaged-app.mjs --dir release/win-unpacked
```

自检流程（`electron/main.ts` 中的 `runPackagedSmoke`）：

1. 以 `TSD_SMOKE_OUTPUT=<json>` 启动打包后的应用（隐藏窗口，不需要显示环境）；
2. 等待渲染进程 `did-finish-load`，确认 `#root` 已挂载；
3. 拉起随包分发的 Python 后端，轮询 `/api/health`；
4. 写出 JSON 报告并以 0/1 退出，脚本据此判定成功或失败。

CI 在 `electron-builder --win nsis` 之后、上传安装包之前执行这一步；
本地打 Windows 包时也建议执行一次。

## 7. 版本号与图标

- 版本号：改 `package.json` 的 `version`（安装包与 `app.getVersion()` 同步）。
- 图标：`python scripts/make-icon.py` 重新生成 `build/icon.png` / `build/icon.ico`；
  也可以直接替换这两个文件（ICO 建议包含 256×256）。

---

## 8. 验证清单

```bash
npm run typecheck                        # 类型检查
npm run build                            # 产物构建
python scripts/e2e/run_e2e.py            # 升级流水线全链路（离线模式）
python scripts/e2e/run_git_e2e.py        # W3 凭证 / Git 推送 / 编辑器 AI 全链路
python scripts/e2e/run_agent_e2e.py      # 编码 Agent 循环（工具 / 验证 / JSON 降级 / 沙箱）
npm run verify:package                   # 打包产物启动自检
```

> 编码 Agent 只依赖标准库（`subprocess` / `asyncio` / `difflib`），
> 不需要额外 PyInstaller hidden-import；只要 `server/tsd/agent_loop.py`、`toolbox.py`、
> `repo_map.py` 被打进 `backend-dist/tsd-server`，安装版里就具备完整的 Agent 能力。

安装包自测：

1. 在干净的 Windows 机器（或虚拟机）安装；
2. 首次启动应看到「正在启动本地 Agent 引擎」，几秒后进入工作台；
3. 新建项目 → 观察 7 个步骤流转 → 查看差异 / 代码 / 对话；
4. 关闭应用后确认 `%APPDATA%/TSD Agent/workspace` 保留数据。
