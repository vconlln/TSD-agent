# CI / 打包工作流模板

GitHub Actions 只识别 `.github/workflows/` 下的文件。这里的三个工作流是**源文件**，
因为当前仓库的 OAuth token 缺少 `workflow` 作用域，无法直接推送该目录。

## 安装（一次性）

```bash
# 1) 授予 workflow 权限（浏览器确认一次）
gh auth refresh -s workflow

# 2) 把模板复制到位并推送
bash scripts/install-workflows.sh
git add .github/workflows && git commit -m "ci: enable GitHub Actions" && git push
```

也可以直接在 GitHub 网页端新建 `.github/workflows/ci.yml` 并粘贴对应内容。

## 文件说明

| 文件 | 作用 |
| --- | --- |
| `ci.yml` | 每次 push / PR：类型检查 + 构建 + 后端端到端测试 |
| `build-windows.yml` | 构建 Windows NSIS 安装包（含 PyInstaller 后端），打 tag 时自动发 Release |
| `build-linux.yml` | 构建 Linux AppImage |

> 只有 `build-windows.yml` 产出的 `TSD-Agent-Setup-x.y.z.exe` 是你最终要的安装包。
