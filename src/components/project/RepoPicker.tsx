import { useState } from 'react'
import { GitBranch, Loader2, Search, Server, Sparkles } from 'lucide-react'
import type { GitReposResult, RepoInfo } from '../../../shared/types'
import { api, ApiError } from '@/lib/api'
import { cn, formatRelative } from '@/lib/utils'
import { Badge, Button, Input } from '@/components/ui'

export function RepoPicker({
  onPick,
  autoFocus = false,
}: {
  onPick: (repo: RepoInfo) => void
  autoFocus?: boolean
}) {
  const [prefix, setPrefix] = useState('')
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<GitReposResult | null>(null)
  const [error, setError] = useState('')
  const [picked, setPicked] = useState<string>('')

  const search = async (value = prefix) => {
    setLoading(true)
    setError('')
    try {
      const data = await api.searchRepos(value.trim())
      setResult(data)
    } catch (err) {
      setResult(null)
      setError(err instanceof ApiError ? err.message : '仓库检索失败')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground/50" />
          <Input
            autoFocus={autoFocus}
            value={prefix}
            onChange={(e) => setPrefix(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                void search()
              }
            }}
            placeholder="输入名称前缀检索仓库，例如 mic → 匹配 micabc / micro-service"
            className="pl-8 font-mono text-[12px]"
          />
        </div>
        <Button size="md" variant="secondary" className="shrink-0 gap-1.5" onClick={() => void search()} loading={loading}>
          <Server className="h-3.5 w-3.5" /> 检索
        </Button>
      </div>

      {error ? (
        <p className="rounded-lg border border-destructive/30 bg-destructive/[0.06] px-2.5 py-2 text-[11.5px] text-destructive">
          {error}
        </p>
      ) : null}

      {result ? (
        <div className="rounded-lg border border-border/60 bg-background/25">
          <div className="flex items-center gap-2 border-b border-border/50 px-2.5 py-1.5">
            <span className="text-[10.5px] uppercase tracking-[0.08em] text-muted-foreground/60">检索结果</span>
            <Badge variant="muted" className="font-mono text-[9.5px]">
              {result.provider}
            </Badge>
            <span className="ml-auto text-[10.5px] text-muted-foreground/60">{result.repos.length} 个仓库</span>
          </div>
          {result.repos.length === 0 ? (
            <div className="px-3 py-4 text-center">
              <p className="text-[11.5px] text-muted-foreground">
                {result.note || '没有匹配的仓库'}
              </p>
            </div>
          ) : (
            <div className="max-h-[220px] overflow-y-auto p-1.5 scroll-area-thin">
              {result.repos.map((repo) => {
                const active = picked === repo.url
                return (
                  <button
                    key={repo.url || repo.name}
                    onClick={() => {
                      setPicked(repo.url)
                      onPick(repo)
                    }}
                    className={cn(
                      'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors',
                      active ? 'bg-primary/10' : 'hover:bg-accent/60',
                    )}
                  >
                    <span className={cn('grid h-6 w-6 shrink-0 place-items-center rounded-md', active ? 'bg-primary/15 text-primary' : 'bg-muted text-muted-foreground')}>
                      <GitBranch className="h-3 w-3" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5">
                        <span className="truncate text-[12px] font-medium">{repo.name}</span>
                        <Badge variant="outline" className="shrink-0 font-mono text-[9px]">
                          {repo.defaultBranch || 'main'}
                        </Badge>
                      </span>
                      <span className="block truncate text-[10.5px] text-muted-foreground/70">
                        {repo.fullName || repo.path || repo.url}
                        {repo.updatedAt ? ` · ${formatRelative(repo.updatedAt)}` : ''}
                      </span>
                    </span>
                    {repo.description ? (
                      <span className="hidden max-w-[180px] truncate text-[10.5px] text-muted-foreground/60 sm:block">
                        {repo.description}
                      </span>
                    ) : null}
                  </button>
                )
              })}
            </div>
          )}
          {result.note && result.repos.length > 0 ? (
            <p className="border-t border-border/50 px-2.5 py-1.5 text-[10.5px] text-[hsl(var(--warning))]">
              {result.note}
            </p>
          ) : null}
        </div>
      ) : (
        <div className="flex items-start gap-2 rounded-lg border border-border/50 bg-muted/20 px-2.5 py-2">
          <Sparkles className="mt-0.5 h-3 w-3 shrink-0 text-primary/70" />
          <p className="text-[10.5px] leading-relaxed text-muted-foreground/80">
            按前缀检索远程仓库（GitLab / GitHub / 通用 REST），也可以在设置里配置本地仓库扫描目录。
            {loading ? <Loader2 className="ml-1 inline h-2.5 w-2.5 animate-spin" /> : null}
          </p>
        </div>
      )}
    </div>
  )
}
