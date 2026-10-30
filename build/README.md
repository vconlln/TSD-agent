# 打包资源

- `icon.png` — 1024×1024 应用图标（由 `scripts/make-icon.py` 生成，可自行替换）
- `icon.ico` — Windows 安装包图标（多尺寸）
- `installer.nsh` — 可选的自定义 NSIS 脚本（当前未启用）

重新生成图标：

```bash
python scripts/make-icon.py
```
