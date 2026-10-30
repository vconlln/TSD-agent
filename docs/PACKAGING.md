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

## 1. 一键方式：GitHub Actions（推荐）

仓库自带工作流模板 `ci/build-windows.yml`（GitHub Actions 只认 `.github/workflows/`，
先安装一次）：

```bash
gh auth refresh -s workflow          # 授予 workflow 权限（缺少时会拒绝推送）
bash scripts/install-workflows.sh    # 复制 ci/*.yml → .github/workflows/
git add .github/workflows && git commit -m "ci: enable GitHub Actions" && git push
```

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

## 5. 版本号与图标

- 版本号：改 `package.json` 的 `version`（安装包与 `app.getVersion()` 同步）。
- 图标：`python scripts/make-icon.py` 重新生成 `build/icon.png` / `build/icon.ico`；
  也可以直接替换这两个文件（ICO 建议包含 256×256）。

---

## 6. 验证清单

```bash
npm run typecheck                    # 类型检查
npm run build                        # 产物构建
python scripts/e2e/run_e2e.py        # 后端全链路（离线模式）
```

安装包自测：

1. 在干净的 Windows 机器（或虚拟机）安装；
2. 首次启动应看到「正在启动本地 Agent 引擎」，几秒后进入工作台；
3. 新建项目 → 观察 7 个步骤流转 → 查看差异 / 代码 / 对话；
4. 关闭应用后确认 `%APPDATA%/TSD Agent/workspace` 保留数据。
