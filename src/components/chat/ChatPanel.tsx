import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowDown,
  ArrowUp,
  Check,
  Copy,
  FileCode2,
  RefreshCw,
  Square,
  Sparkles,
  Trash2,
  User,
  X,
  ChevronDown,
} from 'lucide-react'
import { cn, copyText, formatClock } from '@/lib/utils'
import type { ChatMessage, CodeProposal } from '../../../shared/types'
import { useSessionStore } from '@/stores/session'
import { Badge, Button, Tooltip } from '@/components/ui'
import { MarkdownView } from '@/components/common/MarkdownView'
import { PatchView } from '@/components/diff/PatchView'
import { LogoMark } from '@/components/common/Logo'
import { langOf } from '@/lib/language'
import { ReasoningBlock } from './ReasoningBlock'
import { PlanBlock, ToolStrip } from './ToolStrip'

const SUGGESTIONS = [
  '解释一下这次升级改了什么，以及为什么',
  '给新增的接口补一组单元测试',
  '检查有没有未使用的旧代码，列出来给我确认',
  '把部署步骤整理成可以直接执行的清单',
]

function ProposalCard({
  proposal,
  onApply,
  onDiscard,
  busy,
}: {
  proposal: CodeProposal
  onApply: () => void
  onDiscard: () => void
  busy?: boolean
}) {
  const [openEdit, setOpenEdit] = useState<string | null>(proposal.edits[0]?.path ?? null)
  const additions = proposal.edits.reduce((n, e) => n + e.additions, 0)
  const deletions = proposal.edits.reduce((n, e) => n + e.deletions, 0)

  return (
    <div className="mt-3 overflow-hidden rounded-xl border border-primary/25 bg-primary/[0.04]">
      <div className="flex flex-wrap items-center gap-2 border-b border-primary/15 px-3 py-2">
        <Sparkles className="h-3.5 w-3.5 text-primary" />
        <span className="text-[12px] font-medium text-foreground">代码修改建议</span>
        <Badge variant="muted" className="font-mono">
          {proposal.edits.length} 个文件
        </Badge>
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
      {proposal.summary || proposal.rationale ? (
        <div className="px-3 py-2">
          <p className="text-[12px] leading-relaxed text-foreground/85">{proposal.summary}</p>
          {proposal.rationale ? (
            <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">{proposal.rationale}</p>
          ) : null}
        </div>
      ) : null}
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
                <ChevronDown className={cn('h-3 w-3 shrink-0 text-muted-foreground transition-transform', !open && '-rotate-90')} />
                <FileCode2 className="h-3 w-3 shrink-0 text-muted-foreground/70" />
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

function MessageActions({ message }: { message: ChatMessage }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="mt-1.5 flex items-center gap-1 opacity-0 transition-opacity group-hover/msg:opacity-100">
      <Tooltip content={copied ? '已复制' : '复制回答'}>
        <button
          onClick={async () => {
            if (await copyText(message.content)) {
              setCopied(true)
              setTimeout(() => setCopied(false), 1400)
            }
          }}
          className="grid h-6 w-6 place-items-center rounded text-muted-foreground/70 transition-colors hover:bg-accent hover:text-foreground"
        >
          {copied ? <Check className="h-3 w-3 text-[hsl(var(--success))]" /> : <Copy className="h-3 w-3" />}
        </button>
      </Tooltip>
    </div>
  )
}

const AssistantMessage = memo(
  function AssistantMessage({ message, projectId }: { message: ChatMessage; projectId: string }) {
    const applyProposal = useSessionStore((s) => s.applyProposal)
    const discardProposal = useSessionStore((s) => s.discardProposal)
    const [busy, setBusy] = useState(false)
    const waiting = message.streaming && !message.content && !message.reasoning

    return (
      <div className="group/msg flex gap-3">
        <div className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-full bg-accent-grad text-primary-foreground shadow-[0_2px_10px_-4px_hsl(var(--primary))]">
          <LogoMark size={15} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="mb-1 flex items-center gap-2 text-[10.5px] text-muted-foreground/60">
            <span className="font-medium text-foreground/70">TSD Agent</span>
            <span className="tabular">{formatClock(message.ts)}</span>
          </div>

          {message.reasoning ? (
            <ReasoningBlock
              text={message.reasoning}
              streaming={Boolean(message.streaming && !message.content)}
              durationMs={message.reasoningMs}
            />
          ) : null}

          {message.plan?.length ? <PlanBlock steps={message.plan} /> : null}
          {message.tools?.length ? <ToolStrip calls={message.tools} /> : null}

          {message.error ? (
            <div className="rounded-xl border border-destructive/30 bg-destructive/[0.07] px-3 py-2 text-[12px] text-destructive">
              {message.error}
            </div>
          ) : null}

          {waiting ? (
            <div className="flex items-center gap-2 text-[12.5px] text-muted-foreground">
              <span className="flex gap-1">
                {[0, 1, 2].map((index) => (
                  <span
                    key={index}
                    className="h-1.5 w-1.5 animate-bounce rounded-full bg-primary/60"
                    style={{ animationDelay: String(index * 130) + 'ms' }}
                  />
                ))}
              </span>
              正在读取项目并思考…
            </div>
          ) : message.content ? (
            <MarkdownView content={message.content} className="prose-chat" />
          ) : null}

          {message.streaming && message.content ? (
            <span className="ml-0.5 inline-block h-3.5 w-1.5 animate-caret-blink rounded-sm bg-primary align-middle" />
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

          {!message.streaming && message.content ? <MessageActions message={message} /> : null}
        </div>
      </div>
    )
  },
  (prev, next) => prev.message === next.message && prev.projectId === next.projectId,
)

function UserMessage({ message }: { message: ChatMessage }) {
  return (
    <div className="flex justify-end gap-3">
      <div className="flex max-w-[85%] flex-col items-end">
        <div className="mb-1 flex items-center gap-2 text-[10.5px] text-muted-foreground/60">
          <span className="tabular">{formatClock(message.ts)}</span>
          <span className="font-medium text-foreground/70">你</span>
        </div>
        <div className="whitespace-pre-wrap break-words rounded-2xl rounded-tr-md bg-secondary/80 px-3.5 py-2.5 text-[13px] leading-relaxed text-foreground">
          {message.content}
        </div>
      </div>
      <div className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-full bg-secondary text-muted-foreground">
        <User className="h-3.5 w-3.5" />
      </div>
    </div>
  )
}

function Composer({
  value,
  onChange,
  onSend,
  onStop,
  streaming,
}: {
  value: string
  onChange: (value: string) => void
  onSend: () => void
  onStop: () => void
  streaming: boolean
}) {
  const ref = useRef<HTMLTextAreaElement>(null)

  useLayoutEffect(() => {
    const node = ref.current
    if (!node) return
    node.style.height = 'auto'
    node.style.height = Math.min(node.scrollHeight, 220) + 'px'
  }, [value])

  return (
    <div className="border-t border-border/60 bg-[hsl(var(--background)/0.72)] px-4 py-3 backdrop-blur-xl">
      <div className="mx-auto w-full max-w-3xl">
        <div className="flex items-end gap-2 rounded-2xl border border-border/80 bg-card/70 px-3 py-2 shadow-[0_8px_30px_-16px_hsl(var(--primary)/0.45)] transition-colors focus-within:border-primary/50">
          <textarea
            ref={ref}
            value={value}
            onChange={(event) => onChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault()
                onSend()
              }
            }}
            rows={1}
            placeholder="继续改造这个项目：描述要改什么，或直接问它在干什么"
            className="max-h-[220px] min-h-[26px] w-full resize-none bg-transparent text-[13px] leading-relaxed text-foreground placeholder:text-muted-foreground/60 focus:outline-none scroll-area-thin"
          />
          {streaming ? (
            <Tooltip content="停止生成">
              <button
                onClick={onStop}
                aria-label="停止生成"
                className="mb-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-xl border border-border bg-card text-muted-foreground transition-colors hover:text-foreground"
              >
                <Square className="h-3.5 w-3.5" />
              </button>
            </Tooltip>
          ) : (
            <button
              onClick={onSend}
              disabled={!value.trim()}
              aria-label="发送"
              className={cn(
                'mb-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-xl transition-all',
                value.trim()
                  ? 'bg-accent-grad text-primary-foreground shadow-[0_4px_14px_-6px_hsl(var(--primary))] hover:brightness-110'
                  : 'bg-muted text-muted-foreground/50',
              )}
            >
              <ArrowUp className="h-4 w-4" />
            </button>
          )}
        </div>
        <p className="mt-1.5 text-center text-[10.5px] text-muted-foreground/50">
          Enter 发送 · Shift+Enter 换行 · 改动会以补丁形式给你审阅
        </p>
      </div>
    </div>
  )
}

export function ChatPanel({ projectId, className }: { projectId: string; className?: string }) {
  const runtime = useSessionStore((s) => s.runtimes[projectId])
  const sendChat = useSessionStore((s) => s.sendChat)
  const clearChat = useSessionStore((s) => s.clearChat)
  const cancelRun = useSessionStore((s) => s.cancelRun)
  const [input, setInput] = useState('')
  const [atBottom, setAtBottom] = useState(true)
  const scroller = useRef<HTMLDivElement>(null)
  const messages = runtime?.chat ?? []
  const streaming = messages.some((message) => message.streaming)

  const scrollToBottom = useCallback((smooth = false) => {
    const node = scroller.current
    if (!node) return
    node.scrollTo({ top: node.scrollHeight, behavior: smooth ? 'smooth' : 'auto' })
  }, [])

  const tail = messages[messages.length - 1]
  useEffect(() => {
    if (atBottom) scrollToBottom()
  }, [messages.length, tail?.content, tail?.reasoning, atBottom, scrollToBottom])

  const onScroll = () => {
    const node = scroller.current
    if (!node) return
    const distance = node.scrollHeight - node.scrollTop - node.clientHeight
    setAtBottom(distance < 80)
  }

  const send = useCallback(() => {
    const text = input.trim()
    if (!text || streaming) return
    setInput('')
    setAtBottom(true)
    void sendChat(projectId, text)
  }, [input, streaming, sendChat, projectId])

  const rows = useMemo(
    () => messages.filter((message) => message.role !== 'system'),
    [messages],
  )

  return (
    <div className={cn('flex h-full min-h-0 flex-col', className)}>
      <div className="flex items-center justify-between gap-2 border-b border-border/60 px-4 py-2">
        <div className="flex items-center gap-2 text-[11.5px] text-muted-foreground">
          <span className="grid h-5 w-5 place-items-center rounded-md bg-primary/10 text-primary">
            <Sparkles className="h-3 w-3" />
          </span>
          <span className="font-medium text-foreground/80">与 Agent 对话</span>
          <span className="text-muted-foreground/50">·</span>
          <span>它会读代码、跑验证，并把改动做成可审阅的补丁</span>
        </div>
        {messages.length > 0 ? (
          <Tooltip content="清空对话">
            <Button size="xs" variant="ghost" className="gap-1 text-muted-foreground" onClick={() => clearChat(projectId)}>
              <Trash2 className="h-3 w-3" /> 清空
            </Button>
          </Tooltip>
        ) : null}
      </div>

      <div
        ref={scroller}
        onScroll={onScroll}
        className="relative min-h-0 flex-1 overflow-y-auto scroll-area-thin"
      >
        <div className="mx-auto w-full max-w-3xl space-y-6 px-4 py-6">
          {rows.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-4 py-12 text-center">
              <div className="grid h-12 w-12 place-items-center rounded-2xl bg-accent-grad text-primary-foreground shadow-float">
                <LogoMark size={22} />
              </div>
              <div>
                <h3 className="text-[15px] font-semibold tracking-tight">有什么可以帮你的？</h3>
                <p className="mt-1 text-[12px] text-muted-foreground">
                  我能看到这个项目的方案、代码与差异；要改代码，我会先读再改，并把补丁交给你确认。
                </p>
              </div>
              <div className="grid w-full max-w-lg grid-cols-1 gap-2 sm:grid-cols-2">
                {SUGGESTIONS.map((text) => (
                  <button
                    key={text}
                    onClick={() => setInput(text)}
                    className="rounded-xl border border-border/70 bg-card/50 px-3 py-2 text-left text-[12px] text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground"
                  >
                    {text}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            rows.map((message) =>
              message.role === 'user' ? (
                <UserMessage key={message.id} message={message} />
              ) : (
                <AssistantMessage key={message.id} message={message} projectId={projectId} />
              ),
            )
          )}
        </div>

        {!atBottom && rows.length > 0 ? (
          <button
            onClick={() => scrollToBottom(true)}
            className="sticky bottom-4 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1 rounded-full border border-border bg-card/90 px-3 py-1.5 text-[11px] text-muted-foreground shadow-float backdrop-blur hover:text-foreground"
          >
            <ArrowDown className="h-3 w-3" /> 回到底部
          </button>
        ) : null}
      </div>

      <Composer
        value={input}
        onChange={setInput}
        onSend={send}
        onStop={() => void cancelRun(projectId)}
        streaming={streaming}
      />
    </div>
  )
}
