import { useEffect, useState } from 'react'
import { GitBranch, Save, Search, ServerCog } from 'lucide-react'
import { toast } from 'sonner'
import type { AppSettings } from '../../../shared/types'
import { api, ApiError } from '@/lib/api'
import { Badge, Button, Field, Input } from '@/components/ui'
import { Select } from '@/components/ui/overlays'
import { SectionTitle } from '@/components/common/PageHeader'

export function GitSettingsCard({ settings, onSaved }: { settings: AppSettings; onSaved: (next: AppSettings) => void }) {
  const [git, setGit] = useState({
    provider: settings.git?.provider ?? 'local',
    baseUrl: settings.git?.baseUrl ?? '',
    reposPath: settings.git?.reposPath ?? '/api/v4/projects',
    reposRoot: settings.git?.reposRoot ?? '',
    defaultBranch: settings.git?.defaultBranch ?? 'main',
    authorName: settings.git?.authorName ?? 'TSD Agent',
    authorEmail: settings.git?.authorEmail ?? 'tsd-agent@localhost',
  })
  const [token, setToken] = useState('')
  const [saving, setSaving] = useState(false)
  const [prefix, setPrefix] = useState('')
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ count: number; provider: string; note?: string } | null>(null)

  useEffect(() => {
    setGit({
      provider: settings.git?.provider ?? 'local',
      baseUrl: settings.git?.baseUrl ?? '',
      reposPath: settings.git?.reposPath ?? '/api/v4/projects',
      reposRoot: settings.git?.reposRoot ?? '',
      defaultBranch: settings.git?.defaultBranch ?? 'main',
      authorName: settings.git?.authorName ?? 'TSD Agent',
      authorEmail: settings.git?.authorEmail ?? 'tsd-agent@localhost',
    })
  }, [settings.git])

  const save = async () => {
    setSaving(true)
    try {
      const next = await api.updateSettings({
        git: {
          ...git,
          ...(token.trim() ? { token: token.trim() } : {}),
        },
      })
      setToken('')
      onSaved(next)
      toast.success('Git 配置已保存')
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  const test = async () => {
    setTesting(true)
    setTestResult(null)
    try {
      const data = await api.searchRepos(prefix)
      setTestResult({ count: data.repos.length, provider: data.provider, note: data.note })
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : '检索失败')
    } finally {
      setTesting(false)
    }
  }

  const local = git.provider === 'local'

  return (
    <div className="panel p-4">
      <SectionTitle
        hint="按名称前缀检索仓库，并在项目里新建分支推送"
        action={
          settings.git?.tokenSet ? (
            <Badge variant="success">已配置令牌</Badge>
          ) : (
            <Badge variant="outline">未配置令牌</Badge>
          )
        }
      >
        Git 仓库
      </SectionTitle>

      <div className="mt-3 space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="服务类型" hint="local 扫描本地目录，其余走 REST">
            <Select
              value={git.provider}
              onValueChange={(provider) => setGit({ ...git, provider: provider as typeof git.provider })}
              options={[
                { value: 'local', label: '本地目录扫描', hint: '无需网络，按前缀匹配文件夹' },
                { value: 'gitlab', label: 'GitLab', hint: '/api/v4/projects?search=' },
                { value: 'github', label: 'GitHub', hint: 'search/repositories' },
                { value: 'generic', label: '通用 REST', hint: '自定义检索路径' },
              ]}
            />
          </Field>
          <Field label="默认分支">
            <Input value={git.defaultBranch} onChange={(e) => setGit({ ...git, defaultBranch: e.target.value })} className="font-mono text-sm" />
          </Field>
        </div>

        {local ? (
          <Field label="本地仓库扫描目录" hint="留空则使用 <工作区>/repos">
            <Input
              value={git.reposRoot}
              onChange={(e) => setGit({ ...git, reposRoot: e.target.value })}
              placeholder="/home/me/repos"
              className="font-mono text-sm"
            />
          </Field>
        ) : (
          <>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="服务地址">
                <Input
                  value={git.baseUrl}
                  onChange={(e) => setGit({ ...git, baseUrl: e.target.value })}
                  placeholder="https://git.example.internal"
                  className="font-mono text-sm"
                />
              </Field>
              <Field label="访问令牌" hint={settings.git?.tokenSet ? '已保存（留空不修改）' : '私有仓库必填'}>
                <Input
                  type="password"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  placeholder={settings.git?.tokenSet ? '••••••••' : 'glpat-… / ghp_…'}
                  className="font-mono text-sm"
                />
              </Field>
            </div>
            {git.provider === 'generic' ? (
              <Field label="检索路径" hint="相对服务地址">
                <Input value={git.reposPath} onChange={(e) => setGit({ ...git, reposPath: e.target.value })} className="font-mono text-sm" />
              </Field>
            ) : null}
          </>
        )}

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="提交作者名">
            <Input value={git.authorName} onChange={(e) => setGit({ ...git, authorName: e.target.value })} />
          </Field>
          <Field label="提交作者邮箱">
            <Input value={git.authorEmail} onChange={(e) => setGit({ ...git, authorEmail: e.target.value })} className="font-mono text-sm" />
          </Field>
        </div>

        <div className="flex flex-wrap items-end gap-2 rounded-lg border border-border/50 bg-background/25 px-2.5 py-2">
          <Field label="检索自检" className="min-w-[200px] flex-1">
            <div className="flex gap-2">
              <Input
                value={prefix}
                onChange={(e) => setPrefix(e.target.value)}
                placeholder="前缀，例如 mic"
                className="font-mono text-sm"
              />
              <Button size="sm" variant="secondary" className="shrink-0 gap-1" loading={testing} onClick={() => void test()}>
                <Search className="h-3.5 w-3.5" /> 试检索
              </Button>
            </div>
          </Field>
          {testResult ? (
            <span className="flex items-center gap-1 text-xs text-muted-foreground">
              <GitBranch className="h-3 w-3" /> {testResult.provider} · 命中 {testResult.count} 个
            </span>
          ) : null}
        </div>
        {testResult?.note ? (
          <p className="rounded-lg border border-[hsl(var(--warning)/0.3)] bg-[hsl(var(--warning)/0.06)] px-2.5 py-1.5 text-xs text-[hsl(var(--warning))]">
            {testResult.note}
          </p>
        ) : null}

        <div className="flex items-center gap-2">
          <Button size="sm" variant="primary" className="gap-1.5" loading={saving} onClick={() => void save()}>
            <Save className="h-3.5 w-3.5" /> 保存 Git 配置
          </Button>
          <span className="flex items-center gap-1 text-xs text-muted-foreground/60">
            <ServerCog className="h-3 w-3" /> 需要本机安装 git 命令
          </span>
        </div>
      </div>
    </div>
  )
}
