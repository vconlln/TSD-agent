import { useEffect, useMemo } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Code2, FolderTree, Layers } from 'lucide-react'
import type { Project } from '../../../shared/types'
import type { Side } from '../../../shared/types'
import { useSessionStore, type ProjectRuntime } from '@/stores/session'
import { Badge, Button, Segmented, Tooltip } from '@/components/ui'
import { FileTree } from '@/components/code/FileTree'
import { CodeEditor } from '@/components/code/CodeEditor'

export function CodeTab({ project, runtime }: { project: Project; runtime?: ProjectRuntime }) {
  const [params, setParams] = useSearchParams()
  const side = (params.get('side') as Side) || 'target'
  const path = params.get('path') || ''
  const loadTree = useSessionStore((s) => s.loadTree)
  const treeState = runtime?.trees[side]

  useEffect(() => {
    if (!treeState || (!treeState.tree && !treeState.loading)) void loadTree(project.id, side)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id, side])

  const statuses = useMemo(() => {
    const map: Record<string, { status: string; additions: number; deletions: number }> = {}
    for (const file of runtime?.diff?.files ?? []) {
      map[file.path] = { status: file.status, additions: file.additions, deletions: file.deletions }
    }
    return map
  }, [runtime?.diff])

  const setParamsKeep = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params)
    for (const [key, value] of Object.entries(patch)) {
      if (value === null) next.delete(key)
      else next.set(key, value)
    }
    setParams(next, { replace: true })
  }

  const fileStatus = statuses[path]?.status

  return (
    <div className="grid h-full min-h-0 gap-2.5 lg:grid-cols-[270px_minmax(0,1fr)]">
      <div className="flex min-h-0 flex-col overflow-hidden rounded-xl border border-border/70 bg-card/40">
        <div className="flex shrink-0 items-center gap-2 border-b border-border/60 px-2 py-1.5">
          <Layers className="h-3.5 w-3.5 text-muted-foreground/70" />
          <span className="text-[12.5px] font-medium">项目文件</span>
          <div className="ml-auto">
            <Segmented<Side>
              size="sm"
              value={side}
              onChange={(nextSide) => setParamsKeep({ side: nextSide, path: null })}
              options={[
                { value: 'source', label: '原版' },
                { value: 'target', label: '升级版' },
              ]}
            />
          </div>
        </div>
        <FileTree
          tree={treeState?.tree ?? null}
          loading={treeState?.loading}
          selected={path}
          statuses={statuses}
          onSelect={(nextPath) => setParamsKeep({ path: nextPath, side })}
          emptyLabel={side === 'target' ? '尚未生成升级后的代码' : '尚未下载原始代码'}
          className="min-h-0 flex-1"
        />
        <div className="shrink-0 border-t border-border/60 px-2 py-1.5">
          <Tooltip content={treeState?.root || '目录尚未创建'}>
            <div className="flex items-center gap-1 truncate font-mono text-[11.5px] text-muted-foreground/60">
              <FolderTree className="h-2.5 w-2.5 shrink-0" />
              <span className="truncate">{treeState?.root || '—'}</span>
            </div>
          </Tooltip>
        </div>
      </div>

      <div className="min-h-0 overflow-hidden rounded-xl border border-border/70 bg-card/40">
        {path ? (
          <CodeEditor projectId={project.id} side={side} path={path} className="h-full" />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
            <div className="grid h-12 w-12 place-items-center rounded-2xl border border-border bg-muted/30 text-muted-foreground">
              <Code2 className="h-5 w-5" />
            </div>
            <div>
              <p className="text-[13.5px] font-medium">选择一个文件开始查看</p>
              <p className="mt-1 max-w-sm text-[12.5px] leading-relaxed text-muted-foreground">
                左侧可在「原版」与「升级版」之间切换，带 A / M / D 标记的文件即本次升级的变更文件。
              </p>
            </div>
            <div className="flex items-center gap-1.5">
              <Badge variant="success">A 新增</Badge>
              <Badge variant="warning">M 修改</Badge>
              <Badge variant="danger">D 删除</Badge>
            </div>
            {(runtime?.diff?.files.length ?? 0) > 0 ? (
              <Button
                size="sm"
                variant="secondary"
                className="gap-1.5"
                onClick={() => setParamsKeep({ side: 'target', path: runtime!.diff!.files.find((f) => f.status !== 'deleted')?.path ?? null })}
              >
                查看第一个变更文件
              </Button>
            ) : null}
          </div>
        )}
      </div>
    </div>
  )
}
