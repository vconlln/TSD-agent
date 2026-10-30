#!/usr/bin/env bash
# 把 ci/ 下的 GitHub Actions 模板安装到 .github/workflows/ 并提示推送。
set -euo pipefail
cd "$(dirname "$0")/.."

if ! ls ci/*.yml >/dev/null 2>&1; then
  echo "ci/ 下没有工作流模板" >&2
  exit 1
fi

mkdir -p .github/workflows
cp ci/*.yml .github/workflows/
echo "已安装："
ls -1 .github/workflows

echo
echo "下一步："
echo "  gh auth refresh -s workflow   # 如果推送被拒（缺少 workflow 作用域）"
echo "  git add .github/workflows"
echo "  git commit -m 'ci: enable GitHub Actions'"
echo "  git push"
