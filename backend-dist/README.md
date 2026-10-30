# backend-dist

这里存放**已编译的 Python 后端**，随安装包一起分发（electron-builder 的 `extraResources`）。

## 如何生成

在目标平台上（Windows 上生成 .exe）执行：

```bash
python -m pip install -r server/requirements.txt pyinstaller
python -m PyInstaller --noconfirm server/tsd_server.spec
# 产物：server/dist/tsd-server/
```

然后把产物复制到这里：

```bash
# Windows (PowerShell)
Copy-Item -Recurse server/dist/tsd-server backend-dist/tsd-server

# macOS / Linux
cp -r server/dist/tsd-server backend-dist/tsd-server
```

最终结构：

```
backend-dist/
└── tsd-server/
    ├── tsd-server.exe   # Windows
    ├── tsd-server       # Linux / macOS
    └── _internal/...
```

Electron 主进程会在 `resources/backend/tsd-server/tsd-server(.exe)` 查找它。
若不存在，则回退到系统 Python 运行 `server/main.py`（开发模式）。
