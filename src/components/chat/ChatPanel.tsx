import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowUp,
  Bot,
  Check,
  ChevronDown,
  FileCode2,
  Sparkles,
  SquarePen,
  Trash2,
  User,
  X,
} from 'lucide-react'
import { cn, formatClock } from '@/lib/utils'
import type { ChatMessage, CodeProposal } from '../../../shared/types'
import { useSessionStore } from '@/stores/session'
import { Badge, Button, Spinner, Tooltip } from '@/components/ui'
import { MarkdownView } from '@/components/common/MarkdownView'
import { PatchView } from '@/components/diff/PatchView'
import { LogoMark } from '@/components/common/Logo'
import { langOf } from '@/lib/language'

const SUGGESTIONS = [
  '为新增的接口补充单元测试',
  '把配置项抽到 .env 并更新文档',
  '检查升级后是否有未使用的旧代码并清理',
  '更新 README 与部署说明',
]

function ProposalCard({ proposal, onApply, onDiscard, busy }: {
  proposal: CodeProposal
  onApply: () => void
  onDiscard: () => void
  busy?: boolean
}) {
  const [openEdit, setOpenEdit] = useState<string | null>(proposal.edits[0]?.path ?? null)
  const additions = proposal.edits.reduce((n, e) => n + e.additions, 0)
  const deletions = proposal.edits.reduce((n, e) => n + e.deletions, 0)

  return (
    <div className="mt-2 overflow-hidden rounded-xl border border-primary/25 bg-primary/[0.045]">
      <div className="flex flex-wrap items-center gap-2 border-b border-primary/15 px-3 py-2">
        <Sparkles className="h-3.5 w-3.5 text-primary" />
        <span className="text-[12px] font-medium text-foreground">代码修改建议</span>
        <Badge variant="muted" className="font-mono">{proposal.edits.length} 个文件</Badge>
        <span className="tabular text-[10.5px] text-[hsl(var(--diff-add))]">+{additions}</span>
        <span className="tabular text-[10.5px] text-[hsl(var(--diff-del))]">-{deletions}</span>
        <div className="ml-auto flex items-center gap-1.5">
          {proposal.applied ? (
            <Badge variant="success" className="gap-1">
              <Check className="h-2.5 w-2.5" /> 已应用
            </Badge>
          ) : proposal.discarded ? (
            <Badge variant="muted">已忽略</Badge>
          ) : (
            <>
              <Button size="xs" variant="ghost" onClick={onDiscard} className="gap-1">
                <X className="h-2.5 w-2.5" /> 忽略
              </Button>
              <Button size="xs" variant="primary" loading={busy} onClick={onApply} className="gap-1">
                <Check className="h-2.5 w-2.5" /> 应用到代码
              </Button>
            </>
          )}
        </div>
      </div>
      <div className="px-3 py-2">
        <p className="text-[12px] leading-relaxed text-foreground/85">{proposal.summary}</p>
        {proposal.rationale ? (
          <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">{proposal.rationale}</p>
        ) : null}
      </div>
      <div className="divide-y divide-border/50 border-t border-primary/10">
        {proposal.edits.map((edit) => {
          const open = openEdit === edit.path
          const lang = langOf(edit.path)
          return (
            <div key={edit.path}>
              <button
                onClick={() => setOpenEdit(open ? null : edit.path)}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-primary/[0.04]"
              >
                <ChevronDown className={cn('h-3 w-3 text-muted-foreground transition-transform', !open && '-rotate-90')} />
                <FileCode2 className="h-3 w-3 text-muted-foreground/70" />
                <span className="truncate font-mono text-[11px] text-foreground/85">{edit.path}</span>
                <span className="ml-auto flex shrink-0 items-center gap-1.5 tabular text-[10px]">
                  <span className="text-[hsl(var(--diff-add))]">+{edit.additions}</span>
                  <span className="text-[hsl(var(--diff-del))]">-{edit.deletions}</span>
                  <span className="text-muted-foreground/50">{lang.label}</span>
                </span>
              </button>
              {open && edit.patch ? (
                <div className="max-h-72 overflow-auto border-t border-border/40 scroll-area-thin">
                  <PatchView patch={edit.patch} language={lang.shiki} />
                </div>
              ) : null}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function MessageBubble({ message, projectId }: { message: ChatMessage; projectId: string }) {
  const applyProposal = useSessionStore((s) => s.applyProposal)
  const discardProposal = useSessionStore((s) => s.discardProposal)
  const [busy, setBusy] = useState(false)
  const isUser = message.role === 'user'

  return (
    <div className={cn('flex gap-2.5', isUser && 'flex-row-reverse')}>
      <div
        className={cn(
          'mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full',
          isUser ? 'bg-secondary text-muted-foreground' : 'bg-accent-grad text-primary-foreground shadow-[0_2px_10px_-4px_hsl(var(--primary))]',
        )}
      >
        {isUser ? <User className="h-3 w-3" /> : <LogoMark size={14} />}
      </div>
      <div className={cn('min-w-0 max-w-[calc(100%-40px)]', isUser && 'flex flex-col items-end')}>
        <div className="mb-0.5 flex items-center gap-2 text-[10px] text-muted-foreground/60">
          <span className="font-medium text-foreground/60">{isUser ? '你' : 'Agent'}</span>
          <span className="tabular">{formatClock(message.ts)}</span>
        </div>
        {isUser ? (
          <div className="max-w-full whitespace-pre-wrap break-words rounded-2xl rounded-tr-md border border-border/70 bg-secondary/70 px-3 py-2 text-[12.5px] leading-relaxed">
            {message.content}
          </div>
        ) : (
          <div className="w-full">
            {message.error ? (
              <div className="rounded-xl border border-destructive/30 bg-destructive/[0.07] px-3 py-2 text-[12px] text-destructive">
                {message.error}
              </div>
            ) : message.content ? (
              <div className="rounded-2xl rounded-tl-md border border-border/60 bg-card/50 px-3 py-2">
                <MarkdownView content={message.content} className="prose-xs" />
                {message.streaming ? <span className="ml-0.5 inline-block h-3.5 w-1.5 animate-caret-blink bg-primary align-middle" /> : null}
              </div>
            ) : message.streaming ? (
              <div className="inline-flex items-center gap-2 rounded-xl border border-border/60 bg-card/40 px-3 py-2 text-[11.5px] text-muted-foreground">
                <Spinner size={12} /> 正在理解需求并生成修改…
              </div>
            ) : null}
            {message.proposal ? (
              <ProposalCard
                proposal={message.proposal}
                busy={busy}
                onApply={async () => {
                  setBusy(true)
                  try {
                    await applyProposal(projectId, message.proposal!.id)
                  } finally {
                    setBusy(false)
                  }
                }}
                onDiscard={() => discardProposal(projectId, message.proposal!.id)}
              />
            ) : null}
          </div>
        )}
      </div>
    </div>
  )
}

export function ChatPanel({ projectId, className }: { projectId: string; className?: string }) {
  const runtime = useSessionStore((s) => s.runtimes[projectId])
  const sendChat = useSessionStore((s) => s.sendChat)
  const clearChat = useSessionStore((s) => s.clearChat)
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const scroller = useRef<HTMLDivElement>(null)
  const messages = runtime?.chat ?? []
  const streaming = messages.some((m) => m.streaming)

  useEffect(() => {
    const el = scroller.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages.length, messages[messages.length - 1]?.content])

  const send = async () => {
    const text = input.trim()
    if (!text || sending) return
    setInput('')
    setSending(true)
    try {
      await sendChat(projectId, text)
    } finally {
      setSending(false)
    }
  }

  const lastAssistant = useMemo(() => [...messages].reverse().find((m) => m.role === 'assistant'), [messages])

  return (
    <div className={cn('flex min-h-0 flex-col', className)}>
      <div className="flex shrink-0 items-center gap-2 rounded-t-xl border border-b-0 border-border/70 bg-card/40 px-3 py-2">
        <Bot className="h-3.5 w-3.5 text-primary" />
        <span className="text-[11.5px] font-medium">与 Agent 对话</span>
        <span className="text-[10.5px] text-muted-foreground/60">可继续修改代码与方案，改动会生成差异</span>
        {messages.length ? (
          <Tooltip content="清空对话">
            <button
              onClick={() => clearChat(projectId)}
              className="ml-auto grid h-6 w-6 place-items-center rounded text-muted-foreground/60 transition-colors hover:bg-accent hover:text-foreground"
            >
              <Trash2 className="h-3 w-3" />
            </button>
          </Tooltip>
        ) : null}
      </div>

      <div ref={scroller} className="min-h-0 flex-1 space-y-4 overflow-y-auto border-x border-border/70 bg-background/25 px-3 py-3 scroll-area-thin">
        {messages.length === 0 ? (
          <div className="flex h-full min-h-[180px] flex-col items-center justify-center gap-3 text-center">
            <div className="grid h-11 w-11 place-items-center rounded-2xl bg-accent-grad text-primary-foreground shadow-glow">
              <Bot className="h-5 w-5" />
            </div>
            <div>
              <p className="text-[13px] font-medium">需要调整升级结果？直接说</p>
              <p className="mt-1 max-w-sm text-[11.5px] leading-relaxed text-muted-foreground">
                Agent 已读取项目方案与升级后的代码，可以按你的要求继续修改，并生成可审阅的差异。
              </p>
            </div>
            <div className="flex flex-wrap justify-center gap-1.5">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  onClick={() => setInput(s)}
                  className="rounded-full border border-border/80 bg-card/50 px-2.5 py-1 text-[11px] text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        ) : (
          messages.map((message) => <MessageBubble key={message.id} message={message} projectId={projectId} />)
        )}
      </div>

      <div className="shrink-0 rounded-b-xl border border-border/70 bg-card/50 p-2">
        <div className="relative rounded-lg border border-input bg-background/50 transition-colors focus-within:border-primary/50 focus-within:ring-2 focus-within:ring-primary/15">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                void send()
              }
            }}
            rows={2}
            placeholder="描述需要修改的地方，例如：把 /login 改成 JWT 并补充测试…"
            className="max-h-40 min-h-[52px] w-full resize-none bg-transparent px-3 py-2 pr-12 text-[12.5px] leading-relaxed outline-none placeholder:text-muted-foreground/55"
          />
          <div className="absolute bottom-2 right-2 flex items-center gap-1">
            {streaming ? (
              <span className="mr-1 text-[10px] text-muted-foreground/60">生成中…</span>
            ) : null}
            <Button
              size="icon-sm"
              variant={input.trim() ? 'primary' : 'secondary'}
              onClick={() => void send()}
              disabled={!input.trim() || sending}
              aria-label="发送"
            >
              <ArrowUp className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
        <div className="mt-1.5 flex items-center justify-between px-1 text-[10px] text-muted-foreground/50">
          <span className="flex items-center gap-1">
            <SquarePen className="h-2.5 w-2.5" /> Enter 发送 · Shift+Enter 换行
          </span>
          {lastAssistant?.streaming ? <span className="text-primary/70">Agent 正在工作</span> : null}
        </div>
      </div>
    </div>
  )
}
