#!/usr/bin/env bash
# 在 Linux 上交叉构建 Windows 安装包（后端 PyInstaller + electron-builder NSIS）。
#
# 原理：
#   1) 用 Wine 跑 Windows 版 Python 3.11（embeddable + pip），在里面装依赖与 PyInstaller；
#   2) 用这个 Python 生成 tsd-server.exe（PyInstaller 不能跨平台编译，但可以在 Wine 里跑 Windows 版）；
#   3) electron-builder 在 Linux 上打 NSIS 安装包（rcedit/NSIS 通过 Wine 执行）。
#
# 用法：
#   bash scripts/build-windows-on-linux.sh                  # 构建 + 打印产物路径
#   bash scripts/build-windows-on-linux.sh --verify         # 构建后用 Wine 跑一遍冒烟自检
#   bash scripts/build-windows-on-linux.sh --backend-only   # 只重建后端 tsd-server.exe
#
# 内网定制（环境变量）：
#   EXTRA_REQUIREMENTS="internal-sdk==1.2 other>=0.3"  额外 pip 依赖，一起打进后端
#   EXTRA_RESOURCES_DIR=build/bundled                    额外资源目录，复制到 resources/
#   SKIP_RENDERER_BUILD=1                                跳过前端构建（dist/ 已是最新）
#
# 依赖：wine（>=8）、7za、node/npm、curl、unzip、约 3 GB 磁盘。
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"

PY_VERSION=${PY_VERSION:-3.11.9}
TOOLS_DIR=${TOOLS_DIR:-$ROOT/build-tools}
export WINEPREFIX=${WINEPREFIX:-$TOOLS_DIR/wineprefix}
WINPY=${WINPY:-$TOOLS_DIR/win-python}
export WINEDEBUG=${WINEDEBUG:--all}
# 中间产物放在仓库内：某些环境 /tmp 是易失盘，编译到一半被清掉会产出坏安装包
export TMPDIR=${TMPDIR:-$TOOLS_DIR/tmp}
mkdir -p "$TMPDIR"

# 镜像（国内网络建议保留默认值；能直连 GitHub 时可清空）
export PIP_INDEX_URL=${PIP_INDEX_URL:-https://pypi.tuna.tsinghua.edu.cn/simple}
export ELECTRON_MIRROR=${ELECTRON_MIRROR:-https://npmmirror.com/mirrors/electron/}
export ELECTRON_BUILDER_BINARIES_MIRROR=${ELECTRON_BUILDER_BINARIES_MIRROR:-https://npmmirror.com/mirrors/electron-builder-binaries/}
export ELECTRON_CACHE=${ELECTRON_CACHE:-$ROOT/build-tools/cache/electron}
export ELECTRON_BUILDER_CACHE=${ELECTRON_BUILDER_CACHE:-$ROOT/build-tools/cache/electron-builder}
export XDG_CACHE_HOME=${XDG_CACHE_HOME:-$ROOT/build-tools/cache}
PY_MIRROR=${PY_MIRROR:-https://registry.npmmirror.com/-/binary/python/$PY_VERSION}

VERIFY=0
BACKEND_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --verify) VERIFY=1 ;;
    --backend-only) BACKEND_ONLY=1 ;;
  esac
done

need() { command -v "$1" >/dev/null 2>&1 || { echo "缺少依赖：$1" >&2; exit 1; }; }
need wine
need curl
need unzip
need node
command -v 7za >/dev/null 2>&1 && export ELECTRON_BUILDER_7ZIP_PATH=$(command -v 7za)

mkdir -p "$TOOLS_DIR" "$WINPY" "$ELECTRON_CACHE" "$ELECTRON_BUILDER_CACHE"

echo '==> 1/6 初始化 Wine 前缀'
if [ ! -d "$WINEPREFIX/drive_c" ]; then
  timeout 600 wineboot -u >/dev/null 2>&1 || true
fi

echo "==> 2/6 准备 Windows 版 Python $PY_VERSION"
if [ ! -f "$WINPY/python.exe" ]; then
  curl -sSL --retry 4 -o "$TOOLS_DIR/python-embed.zip" "$PY_MIRROR/python-$PY_VERSION-embed-amd64.zip"
  unzip -oq "$TOOLS_DIR/python-embed.zip" -d "$WINPY"
fi
PTH="$WINPY/python$(echo "$PY_VERSION" | cut -d. -f1,2 | tr -d '.')._pth"
grep -q '^import site' "$PTH" 2>/dev/null || sed -i 's/^#import site/import site/' "$PTH"
grep -qi 'Lib.site-packages' "$PTH" 2>/dev/null || printf 'Lib\\site-packages\n' >> "$PTH"

echo '==> 3/6 安装后端依赖与 PyInstaller（在 Wine 里）'
GETPIP="$TOOLS_DIR/get-pip.py"
if [ ! -f "$GETPIP" ]; then
  curl -sSL --retry 4 -o "$GETPIP" https://bootstrap.pypa.io/get-pip.py
fi
wine "$WINPY/python.exe" "$GETPIP" --no-warn-script-location >/dev/null 2>&1 || true
PIP_ARGS=(-r server/requirements.txt pyinstaller)
if [ -n "${EXTRA_REQUIREMENTS:-}" ]; then
  echo "    额外依赖：$EXTRA_REQUIREMENTS"
  for item in $EXTRA_REQUIREMENTS; do PIP_ARGS+=("$item"); done
fi
wine "$WINPY/python.exe" -m pip install --no-warn-script-location -q "${PIP_ARGS[@]}"

echo '==> 4/6 生成 tsd-server.exe'
( cd server && rm -rf build dist && wine "$WINPY/python.exe" -m PyInstaller --noconfirm --clean tsd_server.spec >/dev/null 2>&1 )
test -f server/dist/tsd-server/tsd-server.exe || { echo 'PyInstaller 未产出 tsd-server.exe' >&2; exit 1; }
rm -rf backend-dist/tsd-server && mkdir -p backend-dist
cp -r server/dist/tsd-server backend-dist/tsd-server
echo "    $(du -sh backend-dist/tsd-server | cut -f1) backend-dist/tsd-server"

if [ "$BACKEND_ONLY" = "1" ]; then
  echo '==> 只构建后端（--backend-only），到此结束'
  exit 0
fi

echo '==> 5/6 构建前端'
if [ "${SKIP_RENDERER_BUILD:-0}" != "1" ]; then
  npm run build >/dev/null
fi

echo '==> 6/6 打包 NSIS 安装包'
rm -rf release
CONFIG_ARGS=()
if [ -n "${EXTRA_RESOURCES_DIR:-}" ]; then
  GENERATED="$TOOLS_DIR/electron-builder.generated.yml"
  {
    echo 'extends: ./electron-builder.yml'
    echo 'extraResources:'
    echo '  - from: backend-dist'
    echo '    to: backend'
    echo "  - from: $EXTRA_RESOURCES_DIR"
    echo '    to: .'
  } > "$GENERATED"
  CONFIG_ARGS=(--config "$GENERATED")
  echo "    额外资源：$EXTRA_RESOURCES_DIR"
fi
npx electron-builder --win nsis --x64 --publish never "${CONFIG_ARGS[@]:-}"
ARTIFACT=$(ls release/*-Setup-*.exe | head -1)
echo
echo "完成：$ARTIFACT（$(du -h "$ARTIFACT" | cut -f1)）"

if [ "$VERIFY" = "1" ]; then
  echo '==> 附加验证：在 Wine 里启动 unpacked 产物做冒烟自检'
  SMOKE="$TOOLS_DIR/win-smoke.json"
  rm -f "$SMOKE"
  ( cd release/win-unpacked && TSD_SMOKE_OUTPUT="Z:$(echo "$SMOKE" | tr '/' '\\')" \
      timeout 240 wine "$(ls *.exe | head -1)" --no-sandbox --disable-gpu --ozone-platform=headless >"$TOOLS_DIR/win-app.log" 2>&1 || true )
  if [ -f "$SMOKE" ]; then
    node -e 'const d=require(process.argv[1]); if(!d.ok){console.error("冒烟失败",JSON.stringify(d));process.exit(1)}; console.log("冒烟通过：", d.backendUrl, d.health.platform, d.health.version)' "$SMOKE"
  else
    echo '未拿到冒烟结果（Wine 下 Electron 可能需要 X 显示；不代表安装包不可用）' >&2
  fi
fi
