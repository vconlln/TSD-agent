import { useEffect, useRef, useState } from 'react'
import { Brain, ChevronDown } from 'lucide-react'
import { cn } from '@/lib/utils'
import { MarkdownView } from '@/components/common/MarkdownView'

/**
 * 「思考过程」折叠块：DeepSeek 风格。
 * - 流式生成中：默认展开，标题显示「正在思考…」
 * - 生成结束：自动折叠，标题显示「已思考 3.2 秒」，点一下可以展开回看
 */
export function ReasoningBlock({
  text,
  streaming,
  durationMs,
}: {
  text: string
  streaming?: boolean
  durationMs?: number
}) {
  const [open, setOpen] = useState<boolean>(streaming !== false)
  const touched = useRef(false)

  useEffect(() => {
    if (streaming) {
      if (!touched.current) setOpen(true)
      return
    }
    if (!touched.current) setOpen(false)
  }, [streaming])

  if (!text.trim()) return null
  const seconds = durationMs && durationMs > 0 ? Math.max(0.1, durationMs / 1000).toFixed(1) : null
  const label = streaming ? '正在思考' : seconds ? '已思考 ' + seconds + ' 秒' : '思考过程'

  return (
    <div className="mb-3 overflow-hidden rounded-xl border border-border/60 bg-[hsl(var(--surface-1)/0.5)]">
      <button
        onClick={() => {
          touched.current = true
          setOpen((value) => !value)
        }}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-[12.5px] text-muted-foreground transition-colors hover:text-foreground"
      >
        <Brain className={cn('h-3.5 w-3.5 shrink-0 text-primary/80', streaming && 'animate-pulse')} />
        <span className="font-medium">{label}</span>
        {streaming ? (
          <span className="flex gap-0.5">
            {[0, 1, 2].map((index) => (
              <span
                key={index}
                className="h-1 w-1 animate-breathe rounded-full bg-primary/60"
                style={{ animationDelay: String(index * 120) + 'ms' }}
              />
            ))}
          </span>
        ) : null}
        <ChevronDown className={cn('ml-auto h-3.5 w-3.5 shrink-0 transition-transform', !open && '-rotate-90')} />
      </button>
      {open ? (
        <div className="border-t border-border/50 px-3 py-2.5">
          <div className="prose-xs text-muted-foreground/90">
            <MarkdownView content={text} className="prose-xs" />
          </div>
        </div>
      ) : null}
    </div>
  )
}
