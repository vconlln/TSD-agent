import { useEffect, useMemo, useState } from 'react'
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  CheckCircle2,
  GitBranch,
  GitCommitHorizontal,
  GitFork,
  GitPullRequest,
  Loader2,
  RefreshCw,
  TriangleAlert,
  UploadCloud,
} from 'lucide-react'
import { toast } from 'sonner'
import type { Project } from '../../../shared/types'
import { useGitStore } from '@/stores/git'
import { useSessionStore } from '@/stores/session'
import { cn, formatRelative } from '@/lib/utils'
import { Badge, Button, Field, Input, Textarea, Tooltip } from '@/components/ui'
import { SectionTitle } from '@/components/common/PageHeader'

function Stat({ label, value, tone }: { label: string; value: React.ReactNode; tone?: 'add' | 'del' | 'muted' }) {
  return (
    <div className="rounded-lg border border-border/60 bg-background/30 px-2.5 py-1.5">
      <div className="text-2xs text-muted-foreground/60">{label}</div>
      <div
        className={cn(
          'stat-num mt-0.5 text-md font-semibold leading-none',
          tone === 'add' ? 'text-[hsl(var(--diff-add))]' : tone === 'del' ? 'text-[hsl(var(--diff-del))]' : 'text-foreground',
        )}
      >
        {value}
      </div>
    </div>
  )
}

export function GitTab({ project }: { project: Project }) {
  const runtime = useGitStore((s) => s.runtimes[project.id])
  const refresh = useGitStore((s) => s.refresh)
  const clone = useGitStore((s) => s.clone)
  const publish = useGitStore((s) => s.publish)
  const compare = useGitStore((s) => s.compare)
  const diff = useSessionStore((s) => s.runtimes[project.id]?.diff)

  const [url, setUrl] = useState(project.sourceUrl ?? '')
  const [cloneBranch, setCloneBranch] = useState('')
  const [cloning, setCloning] = useState(false)

  const [branch, setBranch] = useState(`upgrade/v${project.targetVersion}`)
  const [message, setMessage] = useState(`feat: upgrade to v${project.targetVersion}`)
  const [push, setPush] = useState(true)
  const [force, setForce] = useState(false)
  const [publishing, setPublishing] = useState(false)

  useEffect(() => {
    void refresh(project.id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id])

  const status = runtime?.status
  const compareResult = runtime?.compare
  const dirty = status?.dirty ?? []
  const changedFiles = diff?.files.length ?? 0

  const aheadBehind = useMemo(
    () => ({ ahead: compareResult?.ahead ?? status?.ahead ?? 0, behind: compareResult?.behind ?? status?.behind ?? 0 }),
    [compareResult, status],
  )

  const doClone = async () => {
    if (!url.trim()) {
      toast.error('请输入仓库地址')
      return
    }
    setCloning(true)
    try {
      await clone(project.id, url.trim(), cloneBranch.trim() || undefined)
      toast.success('仓库已克隆到项目工作区')
      await useSessionStore.getState().loadDiff(project.id, true)
      await useSessionStore.getState().refreshProject(project.id)
    } catch (err) {
      toast.error((err as Error).message || '克隆失败')
    } finally {
      setCloning(false)
    }
  }

  const doPublish = async () => {
    setPublishing(true)
    try {
      const result = await publish(project.id, {
        message,
        branch: branch.trim(),
        push,
        createBranch: true,
        force,
      })
      if (result.ok) {
        toast.success(result.note || '已提交')
        if (result.url) window.tsd?.openExternal(result.url)
      } else {
        toast.warning(result.note || '没有可提交的改动')
      }
    } catch (err) {
      toast.error((err as Error).message || '提交失败')
    } finally {
      setPublishing(false)
    }
  }

  if (status && !status.initialized) {
    return (
      <div className="mx-auto max-w-2xl space-y-3 overflow-y-auto pt-4 scroll-area-thin">
        <div className="panel p-4">
          <SectionTitle hint="克隆后即可在本地升级并推送分支">接入 Git 仓库</SectionTitle>
          <div className="mt-3 space-y-3">
            <Field label="仓库地址" hint="HTTPS / SSH / 本地路径均可">
              <Input
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://git.example.com/group/micabc.git"
                className="font-mono text-sm"
              />
            </Field>
            <Field label="分支" hint="留空使用默认分支">
              <Input
                value={cloneBranch}
                onChange={(e) => setCloneBranch(e.target.value)}
                placeholder="main"
                className="font-mono text-sm"
              />
            </Field>
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="primary" size="sm" className="gap-1.5" loading={cloning} onClick={() => void doClone()}>
                <GitFork className="h-3.5 w-3.5" /> 克隆到项目
              </Button>
              <span className="text-xs text-muted-foreground/70">
                {status.gitAvailable === false
                  ? '未检测到 git 命令，请先安装 Git 并加入 PATH'
                  : '克隆后可直接执行升级，升级结果不会污染仓库历史'}
              </span>
            </div>
            {runtime?.error ? (
              <p className="rounded-lg border border-destructive/30 bg-destructive/[0.06] px-2.5 py-2 text-sm text-destructive">
                {runtime.error}
              </p>
            ) : null}
            {runtime?.lastAction ? (
              <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <CheckCircle2 className="h-3 w-3 text-[hsl(var(--success))]" />
                {runtime.lastAction.message}
              </p>
            ) : null}
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="h-full overflow-y-auto pr-1 scroll-area-thin">
      <div className="space-y-3">
        <div className="panel p-3.5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <GitBranch className="h-3.5 w-3.5 text-primary" />
                <span className="font-mono text-sm font-medium">{status?.branch || '—'}</span>
                {status?.upstream ? (
                  <Badge variant="muted" className="font-mono text-2xs">
                    {status.upstream}
                  </Badge>
                ) : (
                  <Badge variant="outline" className="text-2xs">
                    未关联远程
                  </Badge>
                )}
                {aheadBehind.ahead > 0 ? (
                  <Badge variant="success" className="gap-1 text-2xs">
                    <ArrowUpFromLine className="h-2.5 w-2.5" /> 领先 {aheadBehind.ahead}
                  </Badge>
                ) : null}
                {aheadBehind.behind > 0 ? (
                  <Badge variant="warning" className="gap-1 text-2xs">
                    <ArrowDownToLine className="h-2.5 w-2.5" /> 落后 {aheadBehind.behind}
                  </Badge>
                ) : null}
                {dirty.length ? (
                  <Badge variant="warning" className="gap-1 text-2xs">
                    <TriangleAlert className="h-2.5 w-2.5" /> {dirty.length} 个未提交
                  </Badge>
                ) : (
                  <Badge variant="success" className="text-2xs">工作区干净</Badge>
                )}
              </div>
              <button
                className="mt-1.5 flex max-w-[560px] items-center gap-1 truncate font-mono text-xs text-muted-foreground/70 hover:text-primary"
                onClick={() => status?.remoteUrl && window.tsd?.openExternal(status.remoteUrl)}
              >
                <GitFork className="h-3 w-3 shrink-0" />
                <span className="truncate">{status?.remoteUrl || status?.sourceUrl || '未配置远程地址'}</span>
              </button>
              {status?.lastCommit ? (
                <p className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground/70">
                  <GitCommitHorizontal className="h-3 w-3" />
                  <span className="font-mono">{status.lastCommit.sha}</span>
                  <span className="truncate">{status.lastCommit.message}</span>
                  <span>· {status.lastCommit.author}</span>
                  <span>· {formatRelative(Date.parse(status.lastCommit.date))}</span>
                </p>
              ) : null}
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              <Button
                size="xs"
                variant="secondary"
                className="gap-1"
                loading={runtime?.loadingCompare}
                onClick={() => void compare(project.id)}
              >
                <RefreshCw className="h-3 w-3" /> 拉取并对比
              </Button>
              <Tooltip content="重新读取仓库状态">
                <Button size="icon-sm" variant="ghost" onClick={() => void refresh(project.id)}>
                  <RefreshCw className={cn('h-3.5 w-3.5', runtime?.loading && 'animate-spin')} />
                </Button>
              </Tooltip>
            </div>
          </div>

          <div className="mt-3 grid gap-2 sm:grid-cols-4">
            <Stat label="升级变更文件" value={changedFiles} />
            <Stat label="本地提交领先" value={aheadBehind.ahead} tone={aheadBehind.ahead ? 'add' : 'muted'} />
            <Stat label="远程提交落后" value={aheadBehind.behind} tone={aheadBehind.behind ? 'del' : 'muted'} />
            <Stat label="未提交改动" value={dirty.length} tone={dirty.length ? 'del' : 'muted'} />
          </div>

          {dirty.length ? (
            <div className="mt-2 rounded-lg border border-[hsl(var(--warning)/0.3)] bg-[hsl(var(--warning)/0.06)] px-2.5 py-1.5">
              <p className="text-xs font-medium text-[hsl(var(--warning))]">工作区有未提交改动</p>
              <div className="mt-1 flex flex-wrap gap-1">
                {dirty.slice(0, 10).map((entry) => (
                  <span key={entry.path} className="rounded bg-background/50 px-1.5 py-0.5 font-mono text-2xs text-muted-foreground">
                    {entry.path}
                  </span>
                ))}
                {dirty.length > 10 ? <span className="text-2xs text-muted-foreground">…</span> : null}
              </div>
            </div>
          ) : null}
        </div>

        <div className="grid gap-3 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
          <div className="panel min-w-0 p-3.5">
            <SectionTitle
              hint={compareResult?.base ? `对比 ${compareResult.base}` : '本地 vs 远程'}
              action={
                compareResult?.fetched ? <Badge variant="muted" className="text-2xs">已 fetch</Badge> : null
              }
            >
              本地与远程对比
            </SectionTitle>

            {compareResult?.ok === false ? (
              <p className="mt-2 rounded-lg border border-border/60 bg-muted/20 px-2.5 py-2 text-xs text-muted-foreground">
                {compareResult.note || '暂无可对比的远程分支'}
              </p>
            ) : (
              <div className="mt-2 space-y-2">
                <div className="flex items-center gap-3 text-xs text-muted-foreground">
                  <span className="flex items-center gap-1">
                    <ArrowUpFromLine className="h-3 w-3 text-[hsl(var(--diff-add))]" /> 待推送 {aheadBehind.ahead}
                  </span>
                  <span className="flex items-center gap-1">
                    <ArrowDownToLine className="h-3 w-3 text-[hsl(var(--diff-mod))]" /> 待拉取 {aheadBehind.behind}
                  </span>
                  <span className="ml-auto">{compareResult?.files?.length ?? 0} 个文件差异</span>
                </div>

                <div className="max-h-[190px] space-y-1 overflow-y-auto scroll-area-thin">
                  {(compareResult?.commits ?? []).length === 0 ? (
                    <p className="px-1 py-2 text-xs text-muted-foreground/60">
                      本地与 {compareResult?.base || '远程'} 一致
                    </p>
                  ) : (
                    (compareResult?.commits ?? []).map((commit) => (
                      <div key={commit.sha} className="flex items-start gap-2 rounded-md px-1.5 py-1 hover:bg-accent/50">
                        <span className="shrink-0 font-mono text-2xs text-primary/80">{commit.sha}</span>
                        <span className="min-w-0 flex-1 truncate text-xs text-foreground/85">{commit.subject}</span>
                      </div>
                    ))
                  )}
                </div>

                {(compareResult?.incoming ?? []).length ? (
                  <div className="rounded-lg border border-border/50 bg-muted/20 p-1.5">
                    <p className="px-1 text-2xs text-muted-foreground/60">远程有而本地没有</p>
                    {compareResult?.incoming?.slice(0, 5).map((commit) => (
                      <div key={commit.sha} className="flex items-center gap-2 px-1 py-0.5">
                        <span className="font-mono text-2xs text-muted-foreground">{commit.sha}</span>
                        <span className="truncate text-xs text-muted-foreground">{commit.subject}</span>
                      </div>
                    ))}
                  </div>
                ) : null}

                {(compareResult?.files ?? []).length ? (
                  <div className="max-h-[140px] space-y-0.5 overflow-y-auto rounded-lg border border-border/50 bg-background/20 p-1.5 scroll-area-thin">
                    {(compareResult?.files ?? []).map((file) => (
                      <div key={file.path} className="flex items-center gap-2 px-1 py-0.5">
                        <span
                          className={cn(
                            'w-4 shrink-0 rounded text-center text-2xs font-bold',
                            file.status === 'added'
                              ? 'text-[hsl(var(--diff-add))]'
                              : file.status === 'deleted'
                                ? 'text-[hsl(var(--diff-del))]'
                                : 'text-[hsl(var(--diff-mod))]',
                          )}
                        >
                          {file.status === 'added' ? 'A' : file.status === 'deleted' ? 'D' : file.status === 'renamed' ? 'R' : 'M'}
                        </span>
                        <span className="truncate font-mono text-xs text-muted-foreground">{file.path}</span>
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            )}
          </div>

          <div className="panel min-w-0 p-3.5">
            <SectionTitle hint="新建分支并提交升级结果">提交并推送</SectionTitle>
            <div className="mt-2 space-y-2">
              <Field label="目标分支" hint={branch ? '不存在则新建' : '必填'}>
                <Input value={branch} onChange={(e) => setBranch(e.target.value)} className="font-mono text-sm" />
              </Field>
              <Field label="提交信息">
                <Textarea
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  rows={2}
                  className="text-sm"
                  placeholder="feat: upgrade to v1.5.0"
                />
              </Field>
              <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                <label className="flex cursor-pointer items-center gap-1.5">
                  <input type="checkbox" checked={push} onChange={(e) => setPush(e.target.checked)} className="accent-[hsl(var(--primary))]" />
                  推送到远程
                </label>
                <label className="flex cursor-pointer items-center gap-1.5">
                  <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} className="accent-[hsl(var(--primary))]" />
                  覆盖本地未提交改动
                </label>
              </div>
              <Button
                variant="primary"
                size="sm"
                className="w-full gap-1.5"
                loading={publishing || runtime?.loading}
                onClick={() => void doPublish()}
                disabled={changedFiles === 0 && dirty.length === 0}
              >
                {push ? <UploadCloud className="h-3.5 w-3.5" /> : <GitCommitHorizontal className="h-3.5 w-3.5" />}
                {push ? '创建分支并推送' : '仅提交到本地'}
              </Button>

              {runtime?.lastAction ? (
                <div
                  className={cn(
                    'rounded-lg border px-2.5 py-2 text-xs',
                    runtime.lastAction.ok
                      ? 'border-[hsl(var(--success)/0.3)] bg-[hsl(var(--success)/0.06)] text-[hsl(var(--success))]'
                      : 'border-[hsl(var(--warning)/0.3)] bg-[hsl(var(--warning)/0.06)] text-[hsl(var(--warning))]',
                  )}
                >
                  <div className="flex items-center gap-1.5 font-medium">
                    {runtime.lastAction.ok ? <GitPullRequest className="h-3 w-3" /> : <TriangleAlert className="h-3 w-3" />}
                    {runtime.lastAction.message}
                  </div>
                  <div className="mt-0.5 text-2xs opacity-80">更新于 {formatRelative(runtime.lastAction.at)}</div>
                </div>
              ) : null}

              {runtime?.error ? (
                <p className="rounded-lg border border-destructive/30 bg-destructive/[0.06] px-2.5 py-2 text-xs text-destructive">
                  {runtime.error}
                </p>
              ) : null}

              <p className="text-2xs leading-relaxed text-muted-foreground/60">
                推送前会把升级结果中「变更过的文件」同步进 Git 工作区并提交，未参与升级的文件保持原样。
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
