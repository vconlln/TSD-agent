import { lazy, Suspense, useCallback, useEffect, useState } from 'react'
import {
  AlertCircle,
  Bot,
  Check,
  FileCode2,
  Loader2,
  Lock,
  Pencil,
  Save,
  Sparkles,
  Undo2,
  Wand2,
  X,
} from 'lucide-react'
import { toast } from 'sonner'
import type { ExplainResult, InlineEditResult, Side } from '../../../shared/types'
import { api, ApiError } from '@/lib/api'
import { cn, formatBytes } from '@/lib/utils'
import { langOf } from '@/lib/language'
import { useSessionStore } from '@/stores/session'
import { useGitStore } from '@/stores/git'
import { Badge, Button, Dialog, DialogContent, Skeleton, Spinner, Tooltip } from '@/components/ui'
import { MarkdownView } from '@/components/common/MarkdownView'
import type { EditorSelection } from './MonacoEditor'

const MonacoEditor = lazy(() => import('./MonacoEditor'))
const MonacoDiff = lazy(() => import('./MonacoDiff'))

const PRESETS = ['重构为更小的函数', '补充错误处理与边界检查', '增加单元测试', '加中文注释', '优化性能']

export function CodeEditor({
  projectId,
  path,
  side,
  className,
}: {
  projectId: string
  path: string
  side: Side
  className?: string
}) {
  const readOnly = side === 'source'
  const [original, setOriginal] = useState('')
  const [value, setValue] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [size, setSize] = useState(0)
  const [selection, setSelection] = useState<EditorSelection | null>(null)

  const [saving, setSaving] = useState(false)
  const [thinking, setThinking] = useState(false)
  const [instructionOpen, setInstructionOpen] = useState(false)
  const [instruction, setInstruction] = useState('')
  const [editResult, setEditResult] = useState<InlineEditResult | null>(null)
  const [applying, setApplying] = useState(false)
  const [explainOpen, setExplainOpen] = useState(false)
  const [explainLoading, setExplainLoading] = useState(false)
  const [explain, setExplain] = useState<ExplainResult | null>(null)

  const dirty = value !== original
  const lang = langOf(path)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError('')
    setSelection(null)
    setEditResult(null)
    api
      .file(projectId, side, path)
      .then((file) => {
        if (cancelled) return
        if (file.binary) {
          setError('二进制文件无法在线查看')
          setLoading(false)
          return
        }
        setOriginal(file.content)
        setValue(file.content)
        setSize(file.size)
        setLoading(false)
      })
      .catch((err) => {
        if (cancelled) return
        setError(err instanceof ApiError ? err.message : '无法读取文件')
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [projectId, side, path])

  const refreshDerived = useCallback(() => {
    void useSessionStore.getState().loadDiff(projectId, true)
    void useGitStore.getState().refresh(projectId)
    void useSessionStore.getState().loadTree(projectId, 'target')
  }, [projectId])

  const save = useCallback(async () => {
    if (readOnly || !dirty || saving) return
    setSaving(true)
    try {
      const result = await api.writeFile(projectId, path, value)
      setOriginal(value)
      setSize(result.size)
      toast.success('已保存')
      refreshDerived()
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }, [dirty, path, projectId, readOnly, refreshDerived, saving, value])

  const runEdit = async (text: string) => {
    if (!text.trim()) {
      toast.error('请描述要做的修改')
      return
    }
    setThinking(true)
    try {
      const result = await api.agentEdit(projectId, {
        path,
        instruction: text.trim(),
        startLine: selection?.startLine ?? 0,
        endLine: selection?.endLine ?? 0,
        content: value,
      })
      if (!result.ok) {
        toast.error(result.error || '无法生成修改')
        return
      }
      setEditResult(result)
      setInstructionOpen(false)
      setInstruction('')
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : '生成失败')
    } finally {
      setThinking(false)
    }
  }

  const runExplain = async () => {
    setExplainOpen(true)
    setExplainLoading(true)
    setExplain(null)
    try {
      const result = await api.agentExplain(projectId, {
        path,
        startLine: selection?.startLine ?? 0,
        endLine: selection?.endLine ?? 0,
        content: value,
      })
      setExplain(result)
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : '解释失败')
      setExplainOpen(false)
    } finally {
      setExplainLoading(false)
    }
  }

  const acceptEdit = async () => {
    if (!editResult?.after) return
    setApplying(true)
    try {
      await api.writeFile(projectId, path, editResult.after)
      setValue(editResult.after)
      setOriginal(editResult.after)
      toast.success(`已应用：+${editResult.additions ?? 0} / -${editResult.deletions ?? 0}`)
      setEditResult(null)
      refreshDerived()
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : '写入失败')
    } finally {
      setApplying(false)
    }
  }

  if (loading) {
    return (
      <div className={cn('flex min-h-0 flex-col', className)}>
        <div className="flex items-center gap-2 border-b border-border/60 px-3 py-1.5">
          <Skeleton className="h-4 w-48" />
        </div>
        <div className="space-y-2 p-4">
          {Array.from({ length: 12 }, (_, i) => (
            <Skeleton key={i} className="h-3" style={{ width: `${55 + ((i * 13) % 40)}%` } as React.CSSProperties} />
          ))}
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className={cn('flex h-full flex-col items-center justify-center gap-2 px-6 text-center', className)}>
        <AlertCircle className="h-5 w-5 text-muted-foreground" />
        <p className="text-sm font-medium">无法打开文件</p>
        <p className="max-w-sm text-sm text-muted-foreground">{error}</p>
      </div>
    )
  }

  return (
    <div className={cn('flex min-h-0 flex-col', className)}>
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border/60 px-3 py-1.5">
        <FileCode2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground/70" />
        <span className="truncate font-mono text-sm text-foreground/85">{path}</span>
        <Badge variant="muted" style={{ color: lang.color }}>
          {lang.label}
        </Badge>
        {readOnly ? (
          <Badge variant="outline" className="gap-1 text-2xs">
            <Lock className="h-2.5 w-2.5" /> 原版只读
          </Badge>
        ) : dirty ? (
          <Badge variant="warning" className="gap-1 text-2xs">
            <span className="h-1.5 w-1.5 rounded-full bg-current" /> 未保存
          </Badge>
        ) : null}
        <span className="hidden text-xs tabular text-muted-foreground/60 sm:inline">{formatBytes(size)}</span>

        <div className="ml-auto flex items-center gap-1">
          {!readOnly ? (
            <>
              <Tooltip content="AI 修改选中代码（Ctrl/Cmd + K）">
                <Button
                  size="xs"
                  variant="secondary"
                  className="gap-1"
                  onClick={() => setInstructionOpen(true)}
                  disabled={thinking}
                >
                  {thinking ? <Loader2 className="h-3 w-3 animate-spin" /> : <Wand2 className="h-3 w-3" />}
                  修改
                </Button>
              </Tooltip>
              <Tooltip content="AI 解释选中代码（Ctrl/Cmd + I）">
                <Button size="xs" variant="ghost" className="gap-1" onClick={() => void runExplain()}>
                  <Bot className="h-3 w-3" /> 解释
                </Button>
              </Tooltip>
              <Tooltip content="保存（Ctrl/Cmd + S）">
                <Button
                  size="xs"
                  variant={dirty ? 'primary' : 'ghost'}
                  className="gap-1"
                  onClick={() => void save()}
                  disabled={!dirty}
                  loading={saving}
                >
                  <Save className="h-3 w-3" /> 保存
                </Button>
              </Tooltip>
            </>
          ) : null}
        </div>
      </div>

      <div className="relative min-h-0 flex-1">
        <Suspense
          fallback={
            <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
              <Spinner size={14} /> 正在加载编辑器…
            </div>
          }
        >
          <MonacoEditor
            key={`${side}:${path}`}
            path={path}
            value={value}
            readOnly={readOnly}
            onChange={setValue}
            onSelectionChange={setSelection}
            onSave={() => void save()}
            onAsk={(kind) => (kind === 'explain' ? void runExplain() : setInstructionOpen(true))}
            className="h-full w-full"
          />
        </Suspense>

        {selection && !readOnly ? (
          <div
            className="absolute z-20 flex items-center gap-0.5 rounded-lg border border-border bg-popover/95 p-0.5 shadow-float backdrop-blur"
            style={{ top: Math.max(4, selection.top - 36), left: Math.max(8, selection.left) }}
          >
            <button
              onClick={() => setInstructionOpen(true)}
              className="flex items-center gap-1 rounded-md px-1.5 py-1 text-xs text-foreground hover:bg-accent"
            >
              <Wand2 className="h-3 w-3 text-primary" /> 修改
            </button>
            <button
              onClick={() => void runExplain()}
              className="flex items-center gap-1 rounded-md px-1.5 py-1 text-xs text-foreground hover:bg-accent"
            >
              <Bot className="h-3 w-3" /> 解释
            </button>
            <span className="px-1 text-2xs text-muted-foreground/60">
              {selection.startLine}-{selection.endLine} 行
            </span>
          </div>
        ) : null}

        {explainOpen ? (
          <div className="absolute inset-y-0 right-0 z-30 flex w-[min(92%,380px)] flex-col border-l border-border bg-popover/97 shadow-float backdrop-blur-xl">
            <div className="flex items-center gap-2 border-b border-border/60 px-3 py-2">
              <Bot className="h-3.5 w-3.5 text-primary" />
              <span className="text-sm font-medium">AI 解释</span>
              {explain?.mode ? (
                <Badge variant={explain.mode === 'llm' ? 'success' : 'warning'} className="text-2xs">
                  {explain.mode === 'llm' ? explain.model || '模型' : '离线分析'}
                </Badge>
              ) : null}
              <button
                onClick={() => setExplainOpen(false)}
                className="ml-auto grid h-6 w-6 place-items-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2 scroll-area-thin">
              {explainLoading ? (
                <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
                  <Spinner size={12} /> 正在分析代码…
                </div>
              ) : explain ? (
                <MarkdownView content={explain.text} className="prose-xs" />
              ) : null}
            </div>
          </div>
        ) : null}
      </div>

      <Dialog open={instructionOpen} onOpenChange={setInstructionOpen}>
        <DialogContent
          title="AI 修改代码"
          description={
            selection
              ? `将改写第 ${selection.startLine}-${selection.endLine} 行`
              : '未选中内容，将基于整个文件生成修改'
          }
          className="w-[min(92vw,560px)]"
        >
          <div className="space-y-3 px-5 py-4">
            <div className="flex flex-wrap gap-1.5">
              {PRESETS.map((preset) => (
                <button
                  key={preset}
                  onClick={() => setInstruction((prev) => (prev ? `${prev}\n${preset}` : preset))}
                  className="rounded-full border border-border/70 bg-card/40 px-2 py-0.5 text-xs text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground"
                >
                  + {preset}
                </button>
              ))}
            </div>
            <textarea
              autoFocus
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void runEdit(instruction)
              }}
              rows={4}
              placeholder="描述要做的修改，例如：把这段校验抽成独立函数并补充注释…"
              className="w-full resize-none rounded-lg border border-input bg-background/50 px-3 py-2 text-sm outline-none focus:border-primary/50 focus:ring-2 focus:ring-primary/15"
            />
            {selection ? (
              <div className="max-h-28 overflow-auto rounded-lg border border-border/60 bg-muted/30 p-2 font-mono text-xs leading-relaxed text-muted-foreground scroll-area-thin">
                {selection.text.slice(0, 600)}
                {selection.text.length > 600 ? '…' : ''}
              </div>
            ) : null}
          </div>
          <div className="flex items-center justify-end gap-2 border-t border-border/70 px-5 py-3">
            <Button size="sm" variant="ghost" onClick={() => setInstructionOpen(false)}>
              取消
            </Button>
            <Button
              size="sm"
              variant="primary"
              className="gap-1.5"
              loading={thinking}
              onClick={() => void runEdit(instruction)}
            >
              <Sparkles className="h-3.5 w-3.5" /> 生成修改
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={editResult !== null} onOpenChange={(open) => (!open ? setEditResult(null) : undefined)}>
        <DialogContent
          title="审阅 AI 修改"
          description={editResult?.summary || '确认改动后写入文件'}
          className="w-[min(96vw,1180px)]"
          hideClose={false}
        >
          <div className="space-y-2 px-5 py-3">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="muted" className="font-mono">
                {path}
              </Badge>
              <span className="text-xs text-[hsl(var(--diff-add))]">+{editResult?.additions ?? 0}</span>
              <span className="text-xs text-[hsl(var(--diff-del))]">-{editResult?.deletions ?? 0}</span>
              {editResult?.model ? <Badge variant="outline" className="text-2xs">{editResult.model}</Badge> : null}
              {editResult?.scope === 'selection' ? (
                <Badge variant="outline" className="text-2xs">
                  替换第 {editResult.startLine}-{editResult.endLine} 行
                </Badge>
              ) : (
                <Badge variant="outline" className="text-2xs">整文件重写</Badge>
              )}
              {editResult?.rationale ? (
                <span className="text-xs text-muted-foreground">{editResult.rationale}</span>
              ) : null}
            </div>
            <div className="h-[62vh] overflow-hidden rounded-lg border border-border/70 bg-background/40">
              {editResult ? (
                <Suspense fallback={<div className="flex h-full items-center justify-center"><Spinner /></div>}>
                  <MonacoDiff
                    original={editResult.before ?? ''}
                    modified={editResult.after ?? ''}
                    path={path}
                    className="h-full w-full"
                  />
                </Suspense>
              ) : null}
            </div>
          </div>
          <div className="flex items-center justify-between gap-2 border-t border-border/70 px-5 py-3">
            <span className="text-xs text-muted-foreground/70">
              接受后写入磁盘，可继续用 Git 面板提交
            </span>
            <div className="flex items-center gap-2">
              <Button size="sm" variant="ghost" className="gap-1" onClick={() => setEditResult(null)}>
                <Undo2 className="h-3.5 w-3.5" /> 拒绝
              </Button>
              <Button size="sm" variant="primary" className="gap-1.5" loading={applying} onClick={() => void acceptEdit()}>
                <Check className="h-3.5 w-3.5" /> 接受并写入
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
