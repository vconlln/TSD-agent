# 主题与自定义

整个界面由 **CSS 变量**驱动：`src/index.css` 定义 token，
`tailwind.config.ts` 把它们映射成 Tailwind 颜色，组件只写语义化类名。

## 1. 两轴模型

```
data-mode="dark | light"        ← 明暗：背景、面板、边框、文字、diff 基色
data-theme="violet | ocean | …" ← 强调色：primary、渐变、focus ring、极光
data-density="cozy | compact"   ← 字号与行高
data-effects="full | calm | off"← 背景动效
--radius                        ← 全局圆角（外观面板滑杆）
```

`<html>` 上的这些属性由 `useAppStore.applyToDocument()` 写入，
因此切换主题不需要重渲染组件树，也不会闪烁。

## 2. 新增一套主题

1. 在 `src/index.css` 里加一组变量：

```css
[data-theme='midnight'] {
  --primary: 245 80% 62%;
  --primary-foreground: 0 0% 100%;
  --grad-from: 245 80% 62%;
  --grad-to: 280 80% 58%;
  --ring: 245 80% 62%;
  --brand-soft: 245 80% 62% / 0.14;
  --aurora-1: 245 80% 60%;
  --aurora-2: 280 80% 58%;
  --aurora-3: 200 80% 60%;
}

[data-mode='light'][data-theme='midnight'] {
  --primary: 245 76% 52%;
  --grad-from: 245 76% 52%;
  --grad-to: 280 76% 48%;
  --primary-foreground: 0 0% 100%;
}
```

2. 在 `src/stores/app.ts` 的 `THEMES` 里注册（用于外观面板色板）：

```ts
{ id: 'midnight', name: '午夜蓝', from: 'hsl(245 80% 62%)', to: 'hsl(280 80% 58%)' }
```

刷新即可在「外观」面板看到。

## 3. 关键 token

| 变量 | 用途 |
| --- | --- |
| `--primary` | 主色（按钮、链接、focus ring、进度） |
| `--grad-from` / `--grad-to` | 强调渐变（主按钮、Logo、进度条、tab 下划线） |
| `--background` / `--card` / `--popover` | 页面 / 面板 / 浮层底色 |
| `--muted` / `--muted-foreground` | 次级面与次级文字 |
| `--border` / `--input` | 描边与输入框边框 |
| `--diff-add` / `--diff-del` / `--diff-mod` | 新增 / 删除 / 修改 |
| `--sidebar` | 侧边栏底色 |
| `--aurora-1..3` | 背景极光光斑 |
| `--radius` | 圆角基准（lg = radius，xl = radius + 4） |

## 4. 组件层约定

- 语义类名优先：`bg-card`、`text-muted-foreground`、`border-border`。
- 面板统一用 `.panel`（含顶部微高光 + 1px 描边 + 圆角）。
- 悬浮玻璃用 `.glass` / `.glass-strong`。
- 差异行用 `.diff-row` / `.diff-split-row`（背景与词级高亮都已定义）。
- Markdown 用 `.prose-tsd`。

## 5. 密度与无障碍

- 密度只改根字号与少量尺寸变量，组件仍用 `rem` 相对单位。
- 所有可交互元素都有 `focus-visible` 环，键盘可完整操作。
- 系统开启「减少动态效果」时，`@media (prefers-reduced-motion)` 会关闭动画；
  外观面板的「背景特效」还可单独关闭极光/网格/噪点。

## 6. 图标

`scripts/make-icon.py` 用 Pillow 直接绘制 1024×1024 图标（圆角渐变 + 升级箭头），
输出 `build/icon.png` 与多尺寸 `build/icon.ico`。改配色只需调整脚本里的
两个 RGB 常量。
