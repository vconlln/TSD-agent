import { useMemo, useState } from 'react'
import { Copy, FileText, FolderOpen, RefreshCw, Sparkles, GitCompareArrows, Play } from 'lucide-react'
import { toast } from 'sonner'
import { copyText } from '@/lib/utils'
import type { Project } from '../../../shared/types'
import { useSessionStore, type ProjectRuntime } from '@/stores/session'
import { Badge, Button, EmptyState, Segmented, Skeleton } from '@/components/ui'
import { MarkdownView } from '@/components/common/MarkdownView'
import { PlanDiff } from '@/components/plan/PlanDiff'
import { PatchView } from '@/components/diff/PatchView'

type PlanView = 'plan' | 'update' | 'diff'

export function PlanTab({
  project,
  runtime,
  onStart,
}: {
  project: Project
  runtime?: ProjectRuntime
  onStart: () => void
}) {
  const [view, setView] = useState<PlanView>('update')
  const [rawDiff, setRawDiff] = useState(false)
  const loadDocs = useSessionStore((s) => s.loadDocs)
  const loadDiff = useSessionStore((s) => s.loadDiff)
  const documents = runtime?.documents
  const diff = runtime?.diff

  const content = useMemo(() => {
    if (view === 'plan') return documents?.plan.content ?? ''
    if (view === 'update') return documents?.update.content ?? ''
    return ''
  }, [view, documents])

  const exists = view === 'plan' ? documents?.plan.exists : view === 'update' ? documents?.update.exists : true
  const path = view === 'plan' ? documents?.plan.path : documents?.update.path

  const changedSections = diff?.plan.sections.filter((s) => s.status !== 'unchanged') ?? []

  return (
    <div className="flex h-full min-h-0 flex-col gap-2.5">
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        <Segmented<PlanView>
          value={view}
          onChange={setView}
          options={[
            { value: 'plan', label: '原始方案', icon: <FileText className="h-3 w-3" /> },
            { value: 'update', label: '升级方案', icon: <Sparkles className="h-3 w-3" /> },
            { value: 'diff', label: '差异对比', icon: <GitCompareArrows className="h-3 w-3" />, count: changedSections.length },
          ]}
        />
        <div className="flex items-center gap-1">
          {view === 'diff' ? (
            <Badge variant="muted" className="font-mono">
              PLAN.md → UPDATE.md
            </Badge>
          ) : (
            <>
              <Badge variant="muted" className="font-mono">
                {view === 'plan' ? 'PLAN.md' : 'UPDATE.md'}
              </Badge>
              {exists ? <Badge variant="success">{view === 'plan' ? '已解析' : '已生成'}</Badge> : <Badge variant="outline">未生成</Badge>}
            </>
          )}
        </div>
        <div className="ml-auto flex items-center gap-1">
          {view !== 'diff' && path ? (
            <>
              <Button
                size="xs"
                variant="ghost"
                className="gap-1"
                onClick={() => void copyText(content).then(() => toast.success('已复制 Markdown'))}
              >
                <Copy className="h-3 w-3" /> 复制
              </Button>
              <Button size="xs" variant="ghost" className="gap-1" onClick={() => void window.tsd?.openPath(path)}>
                <FolderOpen className="h-3 w-3" /> 打开文件
              </Button>
            </>
          ) : null}
          {view === 'diff' ? (
            <Button size="xs" variant={rawDiff ? 'subtle' : 'ghost'} onClick={() => setRawDiff((v) => !v)}>
              统一差异视图
            </Button>
          ) : null}
          <Button
            size="xs"
            variant="ghost"
            className="gap-1"
            onClick={() => {
              void loadDocs(project.id)
              void loadDiff(project.id, true)
            }}
          >
            <RefreshCw className="h-3 w-3" /> 刷新
          </Button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-hidden rounded-xl border border-border/70 bg-card/40">
        {view === 'diff' ? (
          <div className="h-full overflow-y-auto p-3 scroll-area-thin">
            {rawDiff ? (
              diff?.plan.unified ? (
                <PatchView patch={diff.plan.unified} language="markdown" layout="unified" />
              ) : (
                <EmptyState icon={<GitCompareArrows className="h-5 w-5" />} title="暂无方案差异" description="执行升级后会生成 UPDATE.md，并与原始方案逐段对比。" />
              )
            ) : changedSections.length || diff?.plan.sections.length ? (
              <PlanDiff sections={diff?.plan.sections} oldMarkdown={documents?.plan.content} newMarkdown={documents?.update.content} />
            ) : (
              <EmptyState
                icon={<GitCompareArrows className="h-5 w-5" />}
                title="暂无方案差异"
                description="执行升级后，这里会按章节展示新增、修改与删除的内容。"
                action={
                  <Button size="sm" variant="primary" className="gap-1.5" onClick={onStart}>
                    <Play className="h-3.5 w-3.5" /> 开始升级
                  </Button>
                }
              />
            )}
          </div>
        ) : runtime?.docsLoading ? (
          <div className="space-y-2 p-4">
            {Array.from({ length: 10 }, (_, i) => (
              <Skeleton key={i} className="h-3.5 w-full" style={{ width: `${70 + ((i * 13) % 30)}%` } as React.CSSProperties} />
            ))}
          </div>
        ) : !exists || !content ? (
          <EmptyState
            icon={<FileText className="h-5 w-5" />}
            title={view === 'plan' ? '还没有解析出的原始方案' : '还没有生成升级方案'}
            description={
              view === 'plan'
                ? 'Agent 会抓取项目页面并提取结构，输出 PLAN.md。执行一次升级即可生成。'
                : '提供升级需求后，Agent 会基于原始方案输出 UPDATE.md。'
            }
            action={
              <Button size="sm" variant="primary" className="gap-1.5" onClick={onStart}>
                <Play className="h-3.5 w-3.5" /> 开始升级
              </Button>
            }
          />
        ) : (
          <div className="h-full overflow-y-auto scroll-area-thin">
            <div className="mx-auto max-w-[820px] px-6 py-5">
              {view === 'update' && changedSections.length ? (
                <div className="mb-4 flex flex-wrap items-center gap-1.5 rounded-lg border border-primary/20 bg-primary/[0.05] px-2.5 py-1.5">
                  <Sparkles className="h-3 w-3 text-primary" />
                  <span className="text-xs text-muted-foreground">
                    本次升级共变更 {changedSections.length} 个章节
                  </span>
                  {changedSections.slice(0, 4).map((s) => (
                    <span key={s.key} className="rounded bg-background/50 px-1.5 py-0.5 text-2xs text-muted-foreground">
                      {s.heading}
                    </span>
                  ))}
                </div>
              ) : null}
              <MarkdownView content={content} />
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
