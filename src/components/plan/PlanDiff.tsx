import { useMemo, useState } from 'react'
import { ChevronDown, Minus, Plus, Pencil, Equal } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { PlanSectionDiff } from '../../../shared/types'
import { diffMarkdownSections, makePatch } from '@/lib/diff'
import { Badge, Segmented } from '@/components/ui'
import { PatchView } from '@/components/diff/PatchView'

const STATUS_META = {
  added: { label: '新增', icon: Plus, cls: 'text-[hsl(var(--diff-add))]', bg: 'bg-[hsl(var(--diff-add)/0.07)]', border: 'border-l-[hsl(var(--diff-add))]' },
  removed: { label: '删除', icon: Minus, cls: 'text-[hsl(var(--diff-del))]', bg: 'bg-[hsl(var(--diff-del)/0.07)]', border: 'border-l-[hsl(var(--diff-del))]' },
  modified: { label: '修改', icon: Pencil, cls: 'text-[hsl(var(--diff-mod))]', bg: 'bg-[hsl(var(--diff-mod)/0.07)]', border: 'border-l-[hsl(var(--diff-mod))]' },
  unchanged: { label: '未变', icon: Equal, cls: 'text-muted-foreground', bg: '', border: 'border-l-transparent' },
} as const

function SectionCard({ section }: { section: PlanSectionDiff }) {
  const [open, setOpen] = useState(section.status !== 'unchanged')
  const meta = STATUS_META[section.status]
  const patch = useMemo(() => {
    if (section.status === 'added') return makePatch('', section.newText || '', 'a/PLAN.md', 'b/UPDATE.md')
    if (section.status === 'removed') return makePatch(section.oldText || '', '', 'a/PLAN.md', 'b/UPDATE.md')
    return makePatch(section.oldText || '', section.newText || '', 'a/PLAN.md', 'b/UPDATE.md')
  }, [section])
  const changedLines = useMemo(() => {
    const lines = patch.split('\n')
    return lines.filter((l) => (l.startsWith('+') && !l.startsWith('+++')) || (l.startsWith('-') && !l.startsWith('---'))).length
  }, [patch])

  if (section.status === 'unchanged') {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-border/50 px-3 py-1.5 text-[12.5px] text-muted-foreground/60">
        <Equal className="h-3 w-3" />
        <span className="truncate">{section.heading}</span>
        <span className="ml-auto shrink-0">未变更</span>
      </div>
    )
  }

  return (
    <div className={cn('overflow-hidden rounded-xl border border-border/70 border-l-2', meta.border, meta.bg)}>
      <button onClick={() => setOpen((v) => !v)} className="flex w-full items-center gap-2 px-3 py-2 text-left">
        <ChevronDown className={cn('h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform', !open && '-rotate-90')} />
        <meta.icon className={cn('h-3.5 w-3.5 shrink-0', meta.cls)} />
        <span className="truncate text-[13px] font-medium text-foreground">{section.heading}</span>
        <Badge variant="outline" className={cn('shrink-0', meta.cls)}>
          {meta.label}
        </Badge>
        <span className="ml-auto shrink-0 text-[12px] tabular text-muted-foreground/60">{changedLines} 行变更</span>
      </button>
      {open ? (
        <div className="border-t border-border/50 bg-background/25">
          <PatchView patch={patch} language="markdown" layout="unified" maxRows={400} />
        </div>
      ) : null}
    </div>
  )
}

export function PlanDiff({
  sections,
  oldMarkdown,
  newMarkdown,
}: {
  sections?: PlanSectionDiff[]
  oldMarkdown?: string
  newMarkdown?: string
}) {
  const [filter, setFilter] = useState<'changed' | 'all'>('changed')
  const resolved = useMemo(() => {
    if (sections?.length) return sections
    if (oldMarkdown || newMarkdown) return diffMarkdownSections(oldMarkdown || '', newMarkdown || '')
    return []
  }, [sections, oldMarkdown, newMarkdown])

  const counts = useMemo(() => {
    const c = { added: 0, removed: 0, modified: 0, unchanged: 0 }
    for (const s of resolved) c[s.status]++
    return c
  }, [resolved])

  const visible = filter === 'changed' ? resolved.filter((s) => s.status !== 'unchanged') : resolved

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1.5">
          <Badge variant="success" className="gap-1">
            <Plus className="h-2.5 w-2.5" /> 新增 {counts.added}
          </Badge>
          <Badge variant="warning" className="gap-1">
            <Pencil className="h-2.5 w-2.5" /> 修改 {counts.modified}
          </Badge>
          <Badge variant="danger" className="gap-1">
            <Minus className="h-2.5 w-2.5" /> 删除 {counts.removed}
          </Badge>
          <Badge variant="muted">未变 {counts.unchanged}</Badge>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <Segmented<'changed' | 'all'>
            size="sm"
            value={filter}
            onChange={setFilter}
            options={[
              { value: 'changed', label: '仅变更', count: counts.added + counts.modified + counts.removed },
              { value: 'all', label: '全部', count: resolved.length },
            ]}
          />
        </div>
      </div>

      {visible.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border/80 px-4 py-10 text-center text-[12.5px] text-muted-foreground">
          方案暂无差异。生成升级方案后，这里会按章节展示新增、修改与删除内容。
        </div>
      ) : (
        <div className="space-y-2">
          {visible.map((section) => (
            <SectionCard key={`${section.key}-${section.status}`} section={section} />
          ))}
        </div>
      )}
    </div>
  )
}
