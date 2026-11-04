import { useState } from 'react'
import { ChevronDown, Copy, FileCode2, FolderOpen } from 'lucide-react'
import { cn, copyText } from '@/lib/utils'
import type { DiffFile } from '../../../shared/types'
import { langOf, statusMeta } from '@/lib/language'
import { Badge, Button, Tooltip } from '@/components/ui'
import { PatchView } from './PatchView'

export function FileDiffCard({
  file,
  defaultOpen = false,
  projectId,
  onOpenFile,
}: {
  file: DiffFile
  defaultOpen?: boolean
  projectId?: string
  onOpenFile?: (path: string) => void
}) {
  const [open, setOpen] = useState(defaultOpen)
  const meta = statusMeta(file.status)
  const lang = langOf(file.path)

  return (
    <div className={cn('overflow-hidden rounded-xl border border-border/80 bg-card/40 transition-colors', open && 'border-border')}>
      <div
        className="flex cursor-pointer items-center gap-2 px-3 py-2 hover:bg-accent/40"
        onClick={() => setOpen((v) => !v)}
      >
        <ChevronDown className={cn('h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform', !open && '-rotate-90')} />
        <span
          className={cn('grid h-5 w-5 shrink-0 place-items-center rounded-[5px] border text-[11.5px] font-bold', meta.cls)}
          title={file.status}
        >
          {meta.label}
        </span>
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate font-mono text-[12.5px] text-foreground/90">{file.path}</span>
          {file.oldPath ? (
            <span className="truncate font-mono text-[12px] text-muted-foreground/60">← {file.oldPath}</span>
          ) : null}
        </span>
        <Badge variant="muted" className="hidden shrink-0 sm:inline-flex" style={{ color: lang.color }}>
          {lang.label}
        </Badge>
        <span className="ml-auto flex shrink-0 items-center gap-2 tabular text-[12px]">
          {file.binary ? (
            <span className="text-muted-foreground">二进制</span>
          ) : (
            <>
              <span className="text-[hsl(var(--diff-add))]">+{file.additions}</span>
              <span className="text-[hsl(var(--diff-del))]">-{file.deletions}</span>
              <span className="hidden items-center gap-1 text-muted-foreground/70 sm:flex">
                <span className="inline-flex h-1.5 w-16 overflow-hidden rounded-full bg-muted">
                  <span
                    className="h-full bg-[hsl(var(--diff-add))]"
                    style={{ width: `${Math.min(100, (file.additions / Math.max(1, file.additions + file.deletions)) * 100)}%` }}
                  />
                  <span className="h-full flex-1 bg-[hsl(var(--diff-del))]" />
                </span>
              </span>
            </>
          )}
        </span>
        <div className="flex shrink-0 items-center gap-0.5">
          <Tooltip content="复制补丁">
            <button
              onClick={(e) => {
                e.stopPropagation()
                void copyText(file.patch)
              }}
              className="grid h-6 w-6 place-items-center rounded text-muted-foreground/70 transition-colors hover:bg-accent hover:text-foreground"
            >
              <Copy className="h-3 w-3" />
            </button>
          </Tooltip>
          {onOpenFile ? (
            <Tooltip content="在代码视图中打开">
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  onOpenFile(file.path)
                }}
                className="grid h-6 w-6 place-items-center rounded text-muted-foreground/70 transition-colors hover:bg-accent hover:text-foreground"
              >
                <FileCode2 className="h-3 w-3" />
              </button>
            </Tooltip>
          ) : null}
          {projectId ? (
            <Tooltip content="在文件夹中显示">
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  void window.tsd?.revealPath(file.path)
                }}
                className="hidden h-6 w-6 place-items-center rounded text-muted-foreground/70 transition-colors hover:bg-accent hover:text-foreground"
              >
                <FolderOpen className="h-3 w-3" />
              </button>
            </Tooltip>
          ) : null}
        </div>
      </div>

      {open ? (
        file.binary ? (
          <div className="border-t border-border/60 px-4 py-6 text-center text-[12.5px] text-muted-foreground">
            二进制文件已修改，无法以文本形式展示差异
          </div>
        ) : (
          <div className="max-h-[560px] overflow-auto border-t border-border/60 scroll-area-thin">
            <PatchView patch={file.patch} language={lang.shiki} />
            {file.truncated ? (
              <div className="border-t border-border/60 bg-muted/30 px-3 py-1.5 text-center text-[12px] text-muted-foreground">
                文件过大，差异已截断
              </div>
            ) : null}
          </div>
        )
      ) : null}
    </div>
  )
}

export function FileDiffList({
  files,
  projectId,
  onOpenFile,
  emptyLabel = '暂无代码差异',
}: {
  files: DiffFile[]
  projectId?: string
  onOpenFile?: (path: string) => void
  emptyLabel?: string
}) {
  const [query, setQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState<'all' | 'added' | 'modified' | 'deleted'>('all')

  const filtered = files.filter((f) => {
    if (statusFilter !== 'all' && f.status !== statusFilter) return false
    if (query && !f.path.toLowerCase().includes(query.toLowerCase())) return false
    return true
  })

  if (!files.length) {
    return (
      <div className="rounded-xl border border-dashed border-border/80 px-4 py-10 text-center text-[12.5px] text-muted-foreground">
        {emptyLabel}
      </div>
    )
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="筛选文件路径…"
          className="h-7 w-48 rounded-md border border-input bg-background/40 px-2 font-mono text-[12px] outline-none focus:border-primary/50"
        />
        <div className="flex items-center gap-1">
          {([
            ['all', `全部 ${files.length}`],
            ['added', '新增'],
            ['modified', '修改'],
            ['deleted', '删除'],
          ] as const).map(([value, label]) => (
            <Button
              key={value}
              size="xs"
              variant={statusFilter === value ? 'subtle' : 'ghost'}
              onClick={() => setStatusFilter(value)}
            >
              {label}
            </Button>
          ))}
        </div>
        <span className="ml-auto text-[12px] text-muted-foreground/70">{filtered.length} 个文件</span>
      </div>
      {filtered.map((file, idx) => (
        <FileDiffCard
          key={file.path}
          file={file}
          projectId={projectId}
          onOpenFile={onOpenFile}
          defaultOpen={filtered.length === 1 || idx === 0}
        />
      ))}
    </div>
  )
}
