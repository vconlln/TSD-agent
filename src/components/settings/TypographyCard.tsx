import { useCallback, useEffect, useState } from 'react'
import { MonitorSmartphone, RotateCcw, Type } from 'lucide-react'
import type { FontListResult } from '../../../shared/bridge'
import { useAppStore } from '@/stores/app'
import { Button, Field } from '@/components/ui'
import { Slider } from '@/components/ui/overlays'
import { SectionTitle } from '@/components/common/PageHeader'
import { FontPicker } from './FontPicker'

const ZOOMS = [
  { label: '90%', value: 0.9 },
  { label: '100%', value: 1 },
  { label: '110%', value: 1.1 },
  { label: '125%', value: 1.25 },
  { label: '150%', value: 1.5 },
]

/**
 * 文字与缩放：字号倍率（只放大文字）与页面缩放（整页等比）。
 * 页面缩放走 Electron zoomFactor，Chromium 会按倍率重新栅格化，高分屏不会糊。
 */
export function TypographyCard() {
  const appearance = useAppStore((s) => s.appearance)
  const setAppearance = useAppStore((s) => s.setAppearance)
  const resetAppearance = useAppStore((s) => s.resetAppearance)
  const [fonts, setFonts] = useState<FontListResult | null>(null)
  const [scanning, setScanning] = useState(false)

  const scan = useCallback(async (force = false) => {
    const bridge = window.tsd
    if (!bridge) {
      // 浏览器预览没有 IPC：给一份可用度较高的兜底清单
      setFonts({
        families: ['PingFang SC', 'Microsoft YaHei', 'Noto Sans SC', 'Source Han Sans SC', 'SimSun', 'Inter', 'JetBrains Mono'],
        source: 'builtin-preview',
        truncated: false,
      })
      return
    }
    setScanning(true)
    try {
      setFonts(await bridge.listFonts(force))
    } catch {
      setFonts(null)
    } finally {
      setScanning(false)
    }
  }, [])

  useEffect(() => {
    void scan(false)
  }, [scan])

  const scalePct = Math.round((appearance.fontScale ?? 1) * 100)

  return (
    <div className="panel p-4">
      <SectionTitle
        hint="放大文字或整页，选择系统字体"
        action={
          <Button size="xs" variant="ghost" className="gap-1" onClick={resetAppearance}>
            <RotateCcw className="h-3 w-3" /> 恢复默认
          </Button>
        }
      >
        文字与缩放
      </SectionTitle>

      <div className="mt-3 grid gap-4 lg:grid-cols-2">
        <div className="space-y-4">
          <Field label={'字号缩放 ' + scalePct + '%'} hint="只放大文字，不改布局密度；对高分屏更友好的最小步进是 5%">
            <Slider
              value={scalePct}
              min={85}
              max={140}
              step={5}
              onValueChange={(next) => setAppearance({ fontScale: next / 100 })}
            />
          </Field>

          <Field
            label="页面缩放"
            hint="整页等比缩放（Electron 按倍率重排 + 重新栅格化，比直接拉伸清晰）"
          >
            <div className="flex flex-wrap gap-1.5">
              {ZOOMS.map((item) => (
                <button
                  key={item.value}
                  onClick={() => setAppearance({ uiZoom: item.value })}
                  className={
                    'inline-flex h-8 items-center gap-1 rounded-lg border px-2.5 text-xs transition-colors ' +
                    (Math.abs((appearance.uiZoom ?? 1) - item.value) < 0.001
                      ? 'border-primary/50 bg-primary/10 text-foreground'
                      : 'border-border text-muted-foreground hover:bg-accent hover:text-foreground')
                  }
                >
                  {item.label}
                </button>
              ))}
            </div>
          </Field>

          <div className="rounded-lg border border-border bg-surface-2 p-3">
            <div className="flex items-center gap-1.5 text-xs font-medium text-foreground/80">
              <MonitorSmartphone className="h-3.5 w-3.5" /> 预览
            </div>
            <p className="mt-1.5 text-base leading-relaxed text-foreground/90">订单中心 v1.4.0 → v1.5.0，2 个文件变更</p>
            <p className="mt-1 flex items-baseline gap-3 font-display text-md text-foreground">
              <span>v1.5.0</span>
              <span>7 步</span>
              <span>12.4s</span>
            </p>
            <p className="mt-1 font-mono text-xs text-muted-foreground">src/order/createOrder.ts</p>
          </div>
        </div>

        <div className="space-y-3">
          <div className="flex items-center gap-1.5 text-xs font-medium text-foreground/80">
            <Type className="h-3.5 w-3.5" /> 字体
          </div>
          <FontPicker
            label="正文"
            value={appearance.fontSans}
            onChange={(family) => setAppearance({ fontSans: family })}
            fonts={fonts}
            onScan={() => void scan(true)}
            scanning={scanning}
            preview="输入的方案会被拆成步骤，逐条落到代码里"
            hint="中文建议选系统中文字体（如微软雅黑 / 苹方 / 思源黑体）；英文可选 IBM Plex Sans 等"
          />
          <FontPicker
            label="显示（数字与版本号）"
            value={appearance.fontDisplay}
            onChange={(family) => setAppearance({ fontDisplay: family })}
            fonts={fonts}
            onScan={() => void scan(true)}
            scanning={scanning}
            preview="v1.5.0 → 7/7 → +128 −24"
            hint="等宽或几何无衬线更耐看；留空使用内置 Spline Sans Mono"
          />
          <FontPicker
            label="代码"
            value={appearance.fontMono}
            onChange={(family) => setAppearance({ fontMono: family })}
            fonts={fonts}
            onScan={() => void scan(true)}
            scanning={scanning}
            preview="export function createOrder(id: string) {}"
            hint="需要等宽字体；留空使用内置 JetBrains Mono"
          />
        </div>
      </div>
    </div>
  )
}
