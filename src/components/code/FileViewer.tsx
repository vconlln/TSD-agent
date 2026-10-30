import { useEffect, useState } from 'react'
import { AlertCircle, Copy, FileQuestion, WrapText } from 'lucide-react'
import { cn, copyText, formatBytes } from '@/lib/utils'
import type { Side } from '../../../shared/types'
import { useSessionStore } from '@/stores/session'
import { useAppStore } from '@/stores/app'
import { Badge, Button, EmptyState, Skeleton, Tooltip } from '@/components/ui'
import { CodeBlock } from '@/components/common/CodeBlock'
import { langOf, statusMeta } from '@/lib/language'

export function FileViewer({
  projectId,
  side,
  path,
  status,
  className,
}: {
  projectId: string
  side: Side
  path: string
  status?: string
  className?: string
}) {
  const runtime = useSessionStore((s) => s.runtimes[projectId])
  const loadFile = useSessionStore((s) => s.loadFile)
  const wrapSetting = useAppStore((s) => s.appearance.codeWrap)
  const setAppearance = useAppStore((s) => s.setAppearance)
  const [wrap, setWrap] = useState(wrapSetting)
  const key = `${side}:${path}`
  const state = runtime?.files[key]

  useEffect(() => {
    if (path && (!state || state === 'error')) void loadFile(projectId, side, path)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, side, path])

  if (!path) {
    return (
      <EmptyState
        icon={<FileQuestion className="h-5 w-5" />}
        title="选择一个文件"
        description="从左侧目录树中选择文件，即可查看升级前或升级后的完整代码。"
        className={className}
      />
    )
  }

  const meta = status ? statusMeta(status) : null
  const lang = langOf(path)

  return (
    <div className={cn('flex min-h-0 flex-col', className)}>
      <div className="flex shrink-0 items-center gap-2 border-b border-border/60 px-3 py-1.5">
        <span className="truncate font-mono text-[11.5px] text-foreground/85">{path}</span>
        {meta ? <Badge variant="outline" className={meta.cls}>{meta.label}</Badge> : null}
        <Badge variant="muted" style={{ color: lang.color }}>{lang.label}</Badge>
        {state && state !== 'loading' && state !== 'error' ? (
          <span className="text-[10.5px] tabular text-muted-foreground/60">{formatBytes(state.size)}</span>
        ) : null}
        <div className="ml-auto flex items-center gap-0.5">
          <Tooltip content={wrap ? '关闭自动换行' : '自动换行'}>
            <button
              onClick={() => {
                setWrap(!wrap)
                setAppearance({ codeWrap: !wrap })
              }}
              className={cn(
                'grid h-6 w-6 place-items-center rounded transition-colors hover:bg-accent',
                wrap ? 'text-primary' : 'text-muted-foreground/60',
              )}
            >
              <WrapText className="h-3 w-3" />
            </button>
          </Tooltip>
          <Tooltip content="复制内容">
            <button
              onClick={() => state && state !== 'loading' && state !== 'error' && void copyText(state.content)}
              className="grid h-6 w-6 place-items-center rounded text-muted-foreground/60 transition-colors hover:bg-accent hover:text-foreground"
            >
              <Copy className="h-3 w-3" />
            </button>
          </Tooltip>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto scroll-area-thin">
        {!state || state === 'loading' ? (
          <div className="space-y-2 p-4">
            {Array.from({ length: 14 }, (_, i) => (
              <Skeleton key={i} className="h-3 w-full" style={{ opacity: 1 - i * 0.05 } as React.CSSProperties} />
            ))}
          </div>
        ) : state === 'error' ? (
          <EmptyState
            icon={<AlertCircle className="h-5 w-5" />}
            title="无法读取文件"
            description="文件可能已被删除、过大或为二进制文件。"
            action={<Button size="sm" variant="secondary" onClick={() => void loadFile(projectId, side, path)}>重试</Button>}
          />
        ) : state.binary ? (
          <EmptyState icon={<FileQuestion className="h-5 w-5" />} title="二进制文件" description="该文件无法以文本方式预览。" />
        ) : (
          <div className="p-2">
            <CodeBlock
              code={state.content}
              lang={lang.shiki}
              wrap={wrap}
              showLineNumbers
              dense
              className="border-0 bg-transparent"
            />
            {state.truncated ? (
              <p className="px-2 py-2 text-[11px] text-muted-foreground">文件较大，仅显示前 1.5 MB 内容。</p>
            ) : null}
          </div>
        )}
      </div>
    </div>
  )
}
