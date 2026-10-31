import { useEffect, useState } from 'react'
import {
  BadgeCheck,
  Cpu,
  KeyRound,
  LogOut,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  UserRound,
} from 'lucide-react'
import { toast } from 'sonner'
import type { W3Model } from '../../../shared/types'
import { useAuthStore } from '@/stores/auth'
import { useAppStore } from '@/stores/app'
import { api, ApiError } from '@/lib/api'
import { cn, formatDateTime } from '@/lib/utils'
import { Badge, Button, Field, Input, Spinner, StatusDot } from '@/components/ui'
import { SectionTitle } from '@/components/common/PageHeader'

function ModelRow({ model, active, onUse }: { model: W3Model; active: boolean; onUse: () => void }) {
  return (
    <div
      className={cn(
        'flex flex-wrap items-center gap-2 rounded-lg border px-2.5 py-2 transition-colors',
        active ? 'border-primary/40 bg-primary/[0.06]' : 'border-border/60 bg-background/30 hover:border-border',
      )}
    >
      <span className={cn('grid h-6 w-6 place-items-center rounded-md', active ? 'bg-primary/15 text-primary' : 'bg-muted text-muted-foreground')}>
        <Cpu className="h-3 w-3" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-[12px] font-medium">{model.name}</span>
          {model.recommended ? <Badge variant="gradient" className="text-[9px]">推荐</Badge> : null}
        </div>
        <div className="flex flex-wrap items-center gap-1.5 text-[10.5px] text-muted-foreground/70">
          <span className="font-mono">{model.id}</span>
          {model.contextWindow ? <span>· {(model.contextWindow / 1024).toFixed(0)}K 上下文</span> : null}
          {model.tags?.map((tag) => (
            <span key={tag} className="rounded bg-muted/60 px-1 text-[9.5px]">
              {tag}
            </span>
          ))}
        </div>
      </div>
      <Button size="xs" variant={active ? 'subtle' : 'secondary'} onClick={onUse} className="shrink-0">
        {active ? '当前模型' : '用作推理模型'}
      </Button>
    </div>
  )
}

export function W3Card() {
  const status = useAuthStore((s) => s.status)
  const loading = useAuthStore((s) => s.loading)
  const error = useAuthStore((s) => s.error)
  const refresh = useAuthStore((s) => s.refresh)
  const login = useAuthStore((s) => s.login)
  const logout = useAuthStore((s) => s.logout)
  const useModel = useAuthStore((s) => s.useModel)

  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [serverUrl, setServerUrl] = useState('')
  const [savingServer, setSavingServer] = useState(false)
  const [currentModel, setCurrentModel] = useState('')

  useEffect(() => {
    void refresh()
    void api
      .getSettings()
      .then((settings) => {
        setServerUrl(settings.w3?.serverUrl ?? '')
        setCurrentModel(settings.engine.model)
        if (!username && settings.w3?.rememberUsername) setUsername(settings.w3.rememberUsername)
      })
      .catch(() => undefined)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const submit = async () => {
    if (!username.trim() || !password) {
      toast.error('请填写用户名与密码')
      return
    }
    try {
      const next = await login(username.trim(), password)
      setPassword('')
      setCurrentModel(next.models[0]?.id ?? '')
      toast.success(
        next.mode === 'demo'
          ? '已获取演示凭证（未配置 W3 网关）'
          : `已登录：${next.user?.name ?? username}`,
      )
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : '登录失败')
    }
  }

  const saveServer = async () => {
    setSavingServer(true)
    try {
      await api.updateSettings({ w3: { serverUrl: serverUrl.trim() } })
      toast.success(serverUrl.trim() ? '已保存 W3 网关地址' : '已切换为演示模式')
      await refresh()
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : '保存失败')
    } finally {
      setSavingServer(false)
    }
  }

  const authenticated = status?.authenticated === true
  const demo = status?.mode === 'demo'

  return (
    <div className="panel p-4">
      <SectionTitle
        hint="用内网账号换取访问凭证，凭证用于获取可用模型清单"
        action={
          authenticated ? (
            <Badge variant={demo ? 'warning' : 'success'} className="gap-1">
              <BadgeCheck className="h-2.5 w-2.5" />
              {demo ? '演示凭证' : 'W3 已认证'}
            </Badge>
          ) : (
            <Badge variant="outline" className="gap-1">
              <StatusDot tone="idle" /> 未登录
            </Badge>
          )
        }
      >
        W3 访问凭证
      </SectionTitle>

      {authenticated ? (
        <div className="mt-3 space-y-3">
          <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border/60 bg-background/30 px-3 py-2">
            <span className="grid h-8 w-8 place-items-center rounded-full bg-primary/12 text-primary">
              <UserRound className="h-4 w-4" />
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5 text-[12.5px] font-medium">
                {status?.user?.name || '已登录用户'}
                <Badge variant="muted" className="font-mono text-[9.5px]">
                  {status?.tokenPreview || '••••'}
                </Badge>
              </div>
              <div className="text-[10.5px] text-muted-foreground/70">
                {status?.user?.department ? `${status.user.department} · ` : ''}
                {status?.user?.email || '凭证有效期至 ' + formatDateTime(status?.expiresAt)}
              </div>
            </div>
            <Button size="xs" variant="ghost" className="gap-1" onClick={() => void refresh()}>
              <RefreshCw className={cn('h-3 w-3', loading && 'animate-spin')} /> 刷新
            </Button>
            <Button
              size="xs"
              variant="ghost"
              className="gap-1 text-muted-foreground hover:text-destructive"
              onClick={async () => {
                await logout()
                toast.success('已退出 W3 登录')
              }}
            >
              <LogOut className="h-3 w-3" /> 退出
            </Button>
          </div>

          <div>
            <div className="mb-1.5 flex items-center justify-between">
              <span className="text-[10.5px] font-semibold uppercase tracking-[0.1em] text-muted-foreground/60">
                可用模型
              </span>
              <span className="text-[10.5px] text-muted-foreground/60">{status?.models.length ?? 0} 个</span>
            </div>
            <div className="space-y-1.5">
              {(status?.models ?? []).map((model) => (
                <ModelRow
                  key={model.id}
                  model={model}
                  active={currentModel === model.id}
                  onUse={async () => {
                    await useModel(model)
                    setCurrentModel(model.id)
                    toast.success(`推理模型已切换为 ${model.name}`)
                  }}
                />
              ))}
              {!status?.models.length ? (
                <p className="px-2 py-3 text-center text-[11.5px] text-muted-foreground">凭证已获取，但模型清单为空</p>
              ) : null}
            </div>
          </div>

          <p className="flex items-start gap-1.5 rounded-lg border border-border/50 bg-muted/20 px-2.5 py-2 text-[10.5px] leading-relaxed text-muted-foreground/80">
            <KeyRound className="mt-0.5 h-3 w-3 shrink-0" />
            凭证仅保存在本机工作区（密码不落盘）。点击「用作推理模型」只切换模型标识；调用模型仍需在下方「推理引擎」填写网关地址与密钥。
          </p>
        </div>
      ) : (
        <div className="mt-3 space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="用户名" htmlFor="w3-username">
              <Input
                id="w3-username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="工号 / 域账号"
                autoComplete="username"
              />
            </Field>
            <Field label="密码" htmlFor="w3-password">
              <Input
                id="w3-password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void submit()
                }}
                placeholder={demo ? '演示模式：至少 4 位' : '••••••••'}
                autoComplete="current-password"
              />
            </Field>
          </div>

          <Field
            label="W3 网关地址"
            hint={status?.configured ? '已配置：走真实登录' : '留空为演示模式（本地签发凭据）'}
          >
            <div className="flex gap-2">
              <Input
                value={serverUrl}
                onChange={(e) => setServerUrl(e.target.value)}
                placeholder="https://w3.example.internal"
                className="flex-1 font-mono text-[12px]"
              />
              <Button size="sm" variant="secondary" className="shrink-0 gap-1" loading={savingServer} onClick={() => void saveServer()}>
                <ShieldCheck className="h-3.5 w-3.5" /> 保存
              </Button>
            </div>
          </Field>

          {error ? (
            <p className="rounded-lg border border-destructive/30 bg-destructive/[0.06] px-2.5 py-2 text-[11.5px] text-destructive">
              {error}
            </p>
          ) : null}

          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="primary" className="gap-1.5" loading={loading} onClick={() => void submit()}>
              <Sparkles className="h-3.5 w-3.5" /> 登录取凭证
            </Button>
            <span className="text-[11px] text-muted-foreground/70">
              {status?.configured ? '使用内网 W3 服务认证' : '未配置网关时为演示模式，任意账号 + 4 位以上密码即可'}
            </span>
          </div>
        </div>
      )}
      {loading && !authenticated ? <Spinner className="mt-2" size={12} /> : null}
    </div>
  )
}
