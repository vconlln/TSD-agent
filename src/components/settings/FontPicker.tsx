import { useEffect, useMemo, useState } from 'react'
import { ScanSearch, Search } from 'lucide-react'
import type { FontListResult } from '../../../shared/bridge'
import { Input } from '@/components/ui'
import { Select } from '@/components/ui/overlays'
import { cn } from '@/lib/utils'

const BUILTIN = '__builtin__'

/**
 * 字体选择器：列出扫描到的系统字体，可搜索。
 * 选「内置字体」时传空字符串，回到应用自带字体栈。
 */
export function FontPicker({
  label,
  hint,
  value,
  onChange,
  fonts,
  onScan,
  scanning,
  preview,
  className,
}: {
  label: string
  hint?: string
  value: string
  onChange: (family: string) => void
  fonts: FontListResult | null
  onScan: () => void
  scanning: boolean
  preview?: string
  className?: string
}) {
  const [query, setQuery] = useState('')

  const options = useMemo(() => {
    const list = [{ value: BUILTIN, label: '内置字体（推荐）' }]
    const families = fonts?.families ?? []
    const q = query.trim().toLowerCase()
    for (const family of families) {
      if (q && !family.toLowerCase().includes(q)) continue
      list.push({ value: family, label: family })
    }
    return list.slice(0, 220)
  }, [fonts, query])

  useEffect(() => {
    if (!fonts && !scanning) onScan()
  }, [fonts, scanning, onScan])

  return (
    <div className={cn('space-y-1.5', className)}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-foreground/80">{label}</span>
        <button
          type="button"
          onClick={onScan}
          disabled={scanning}
          className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-2xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
        >
          <ScanSearch className="h-3 w-3" />
          {scanning ? '扫描中…' : '重新扫描'}
        </button>
      </div>
      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground/60" />
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜索已安装的字体"
          className="h-8 pl-8 text-sm"
        />
      </div>
      <Select
        value={value || BUILTIN}
        onValueChange={(next) => onChange(next === BUILTIN ? '' : next)}
        options={options}
        className="h-8 text-sm"
      />
      {preview ? (
        <p
          className="truncate rounded-md border border-border/60 bg-surface-2 px-2 py-1.5 text-sm text-foreground/90"
          style={{ fontFamily: value ? '"' + value + '"' : undefined }}
        >
          {preview}
        </p>
      ) : null}
      {hint ? <p className="text-2xs text-muted-foreground/70">{hint}</p> : null}
      {fonts ? (
        <p className="text-2xs text-muted-foreground/60">
          已扫描 {fonts.families.length} 个字体族（{fonts.source === 'windows-registry' ? 'Windows 注册表' : fonts.source === 'fontconfig' ? 'fontconfig' : '字体目录'}）
        </p>
      ) : null}
    </div>
  )
}
