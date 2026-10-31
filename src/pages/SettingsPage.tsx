import { useEffect, useState } from 'react'
import {
  Cpu,
  Database,
  ExternalLink,
  FolderOpen,
  Github,
  Info,
  Loader2,
  Palette,
  Play,
  RefreshCw,
  Save,
  Server,
  Sparkles,
  Terminal,
  Zap,
} from 'lucide-react'
import { toast } from 'sonner'
import type { AppSettings, EngineSettings, SettingsPatch } from '../../shared/types'
import type { AppConfig } from '../../shared/bridge'
import { api } from '@/lib/api'
import { useAppStore, THEMES } from '@/stores/app'
import { Badge, Button, Field, Input, StatusDot, Segmented } from '@/components/ui'
import { Select, Slider, Switch, Tooltip } from '@/components/ui/overlays'
import { PageHeader, SectionTitle } from '@/components/common/PageHeader'
import { W3Card } from '@/components/settings/W3Card'
import { GitSettingsCard } from '@/components/settings/GitSettingsCard'
import { cn } from '@/lib/utils'

type Patch = SettingsPatch

function Card({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn('panel p-4', className)}>{children}</div>
}

function Row({
  label,
  hint,
  children,
}: {
  label: string
  hint?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/50 py-2.5 last:border-0">
      <div className="min-w-0">
        <p className="text-[12.5px] font-medium text-foreground/90">{label}</p>
        {hint ? <p className="mt-0.5 max-w-xl text-[11px] leading-relaxed text-muted-foreground/70">{hint}</p> : null}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  )
}

export function SettingsPage() {
  const health = useAppStore((s) => s.health)
  const backend = useAppStore((s) => s.backend)
  const appearance = useAppStore((s) => s.appearance)
  const setAppearance = useAppStore((s) => s.setAppearance)
  const setThemePanelOpen = useAppStore((s) => s.setThemePanelOpen)
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [config, setConfig] = useState<AppConfig | null>(null)
  const [apiKey, setApiKey] = useState('')
  const [savingEngine, setSavingEngine] = useState(false)
  const [savingBackend, setSavingBackend] = useState(false)
  const [testing, setTesting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const bridge = window.tsd

  useEffect(() => {
    void api
      .getSettings()
      .then(setSettings)
      .catch((err) => setError((err as Error).message))
    if (bridge) void bridge.getConfig().then(setConfig).catch(() => undefined)
  }, [bridge])

  const saveEngine = async () => {
    if (!settings) return
    setSavingEngine(true)
    try {
      const patch: Patch = {
        engine: {
          provider: settings.engine.provider,
          baseUrl: settings.engine.baseUrl,
          model: settings.engine.model,
          temperature: settings.engine.temperature,
          maxTokens: settings.engine.maxTokens,
          timeoutSec: settings.engine.timeoutSec,
          offlineMode: settings.engine.offlineMode,
          ...(apiKey ? { apiKey } : {}),
        },
      }
      const next = await api.updateSettings(patch)
      setSettings(next)
      setApiKey('')
      toast.success('推理引擎配置已保存')
    } catch (err) {
      toast.error((err as Error).message || '保存失败')
    } finally {
      setSavingEngine(false)
    }
  }

  const saveBackend = async () => {
    if (!config || !bridge) return
    setSavingBackend(true)
    try {
      const next = await bridge.setConfig({
        backendMode: config.backendMode,
        externalUrl: config.externalUrl,
        pythonPath: config.pythonPath,
        autoStart: config.autoStart,
      })
      setConfig(next)
      const status = await bridge.restartBackend()
      useAppStore.getState().setBackend(status)
      toast.success('后端配置已更新，正在重启服务')
    } catch (err) {
      toast.error((err as Error).message || '更新失败')
    } finally {
      setSavingBackend(false)
    }
  }

  const testConnection = async () => {
    setTesting(true)
    try {
      const info = await api.health()
      useAppStore.getState().setHealth(info)
      useAppStore.getState().setApiReady(true)
      toast.success(`后端正常 · ${info.engine === 'online' ? '在线推理' : '离线模式'} · ${info.model || '默认模型'}`)
    } catch (err) {
      toast.error((err as Error).message || '连接失败')
    } finally {
      setTesting(false)
    }
  }

  return (
    <div className="h-full overflow-y-auto scroll-area-thin">
      <div className="mx-auto w-full max-w-[900px] space-y-4 px-6 pb-16 pt-7">
        <PageHeader
          eyebrow="设置"
          title="引擎、后端与外观"
          description="配置推理模型、Python 后端连接方式，以及界面外观。所有配置保存在本机。"
          actions={
            <Button size="sm" variant="outline" className="gap-1.5" onClick={() => setThemePanelOpen(true)}>
              <Palette className="h-3.5 w-3.5" /> 外观面板
            </Button>
          }
        />

        {error ? (
          <div className="rounded-xl border border-destructive/30 bg-destructive/[0.06] px-3 py-2 text-[12px] text-destructive">
            {error}
          </div>
        ) : null}

        <W3Card />

        <Card>
          <SectionTitle hint="用于方案升级与代码修改" action={<Badge variant={health?.engine === 'online' ? 'success' : 'warning'} className="gap-1"><StatusDot tone={health?.engine === 'online' ? 'success' : 'warning'} />{health?.engine === 'online' ? '在线' : '离线'}</Badge>}>
            推理引擎
          </SectionTitle>

          {settings ? (
            <div className="mt-3 space-y-3">
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="服务类型">
                  <Select
                    value={settings.engine.provider}
                    onValueChange={(provider) =>
                      setSettings({ ...settings, engine: { ...settings.engine, provider: provider as EngineSettings['provider'] } })
                    }
                    options={[
                      { value: 'openai-compatible', label: 'OpenAI 兼容接口', hint: 'DeepSeek / OpenAI / vLLM / Ollama' },
                      { value: 'offline', label: '离线启发式', hint: '无需密钥，使用内置规则生成' },
                    ]}
                  />
                </Field>
                <Field label="模型名称">
                  <Input
                    value={settings.engine.model}
                    onChange={(e) => setSettings({ ...settings, engine: { ...settings.engine, model: e.target.value } })}
                    placeholder="deepseek-chat"
                    className="font-mono text-[12px]"
                  />
                </Field>
              </div>

              <Field label="接口地址" hint="Base URL，自动补全 /chat/completions">
                <Input
                  value={settings.engine.baseUrl}
                  onChange={(e) => setSettings({ ...settings, engine: { ...settings.engine, baseUrl: e.target.value } })}
                  placeholder="https://api.deepseek.com/v1"
                  className="font-mono text-[12px]"
                />
              </Field>

              <Field
                label="API Key"
                hint={settings.engine.apiKeySet ? '已保存（留空则不修改）' : '尚未设置'}
              >
                <Input
                  type="password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder={settings.engine.apiKeySet ? '••••••••••••••••' : 'sk-…'}
                  className="font-mono text-[12px]"
                />
              </Field>

              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="温度" hint={settings.engine.temperature.toFixed(2)}>
                  <div className="pt-2.5">
                    <Slider
                      min={0}
                      max={1.5}
                      step={0.05}
                      value={settings.engine.temperature}
                      onValueChange={(temperature) => setSettings({ ...settings, engine: { ...settings.engine, temperature } })}
                    />
                  </div>
                </Field>
                <Field label="最大输出 Token">
                  <Input
                    type="number"
                    value={settings.engine.maxTokens}
                    onChange={(e) =>
                      setSettings({ ...settings, engine: { ...settings.engine, maxTokens: Number(e.target.value) || 4096 } })
                    }
                  />
                </Field>
              </div>

              <Row label="离线降级" hint="模型不可用时，使用内置规则生成方案与补丁，保证流程可跑通">
                <Switch
                  checked={settings.engine.offlineMode}
                  onCheckedChange={(offlineMode) => setSettings({ ...settings, engine: { ...settings.engine, offlineMode } })}
                />
              </Row>

              <div className="flex flex-wrap items-center gap-2 pt-1">
                <Button size="sm" variant="primary" className="gap-1.5" loading={savingEngine} onClick={() => void saveEngine()}>
                  <Save className="h-3.5 w-3.5" /> 保存引擎配置
                </Button>
                <Button size="sm" variant="outline" className="gap-1.5" loading={testing} onClick={() => void testConnection()}>
                  <Play className="h-3.5 w-3.5" /> 测试连接
                </Button>
                <span className="text-[11px] text-muted-foreground/60">
                  {health?.model ? `当前模型：${health.model}` : '尚未连接'}
                </span>
              </div>
            </div>
          ) : (
            <div className="mt-3 flex items-center gap-2 text-[12px] text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> 正在读取配置…
            </div>
          )}
        </Card>

        <Card>
          <SectionTitle
            hint="内置后端随安装包分发，也可连接你自己的 Python 服务"
            action={
              <Badge variant={backend.state === 'online' || backend.state === 'external' ? 'success' : 'danger'} className="gap-1">
                <StatusDot tone={backend.state === 'online' || backend.state === 'external' ? 'success' : 'danger'} />
                {backend.state === 'external' ? '外部后端' : backend.state === 'online' ? '内置后端' : '离线'}
              </Badge>
            }
          >
            后端服务
          </SectionTitle>

          <div className="mt-3 space-y-3">
            <Row label="运行方式" hint="内置模式会随应用启动 Python 服务；外部模式连接已有的 HTTP 服务">
              <Segmented<'embedded' | 'external'>
                size="sm"
                value={config?.backendMode ?? 'embedded'}
                onChange={(backendMode) => config && setConfig({ ...config, backendMode })}
                options={[
                  { value: 'embedded', label: '内置后端' },
                  { value: 'external', label: '外部后端' },
                ]}
              />
            </Row>

            {config?.backendMode === 'external' ? (
              <Field label="后端地址" hint="需实现 docs/API.md 中的接口">
                <Input
                  value={config.externalUrl}
                  onChange={(e) => setConfig({ ...config, externalUrl: e.target.value })}
                  placeholder="http://127.0.0.1:8791"
                  className="font-mono text-[12px]"
                />
              </Field>
            ) : (
              <>
                <Field label="Python 解释器" hint="留空则使用内置打包后端；开发时可指定系统 Python">
                  <Input
                    value={config?.pythonPath ?? ''}
                    onChange={(e) => config && setConfig({ ...config, pythonPath: e.target.value })}
                    placeholder="/usr/bin/python3 或 C:\\Python311\\python.exe"
                    className="font-mono text-[12px]"
                  />
                </Field>
                <Row label="工作目录" hint={health?.workspace || '项目文件、方案与代码快照的存放位置'}>
                  <Button
                    size="xs"
                    variant="secondary"
                    className="gap-1"
                    onClick={async () => {
                      const dir = await bridge?.pickDirectory('选择工作目录')
                      if (dir) {
                        await bridge?.setConfig({ workspace: dir })
                        const status = await bridge?.restartBackend()
                        if (status) useAppStore.getState().setBackend(status)
                        toast.success('工作目录已更新')
                      }
                    }}
                  >
                    <FolderOpen className="h-3 w-3" /> 选择
                  </Button>
                </Row>
              </>
            )}

            <div className="rounded-lg border border-border/60 bg-background/30 px-2.5 py-2">
              <div className="flex items-center gap-1.5 font-mono text-[11px] text-muted-foreground">
                <Server className="h-3 w-3 shrink-0" />
                <span className="truncate">{backend.url || '—'}</span>
                <span className="ml-auto flex shrink-0 items-center gap-1">
                  <Terminal className="h-3 w-3" /> pid {backend.pid ?? '—'}
                </span>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" variant="primary" className="gap-1.5" loading={savingBackend} onClick={() => void saveBackend()} disabled={!bridge}>
                <Save className="h-3.5 w-3.5" /> 保存并重启后端
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="gap-1.5"
                onClick={async () => {
                  const status = await bridge?.restartBackend()
                  if (status) useAppStore.getState().setBackend(status)
                  toast.success('已请求重启后端')
                }}
              >
                <RefreshCw className="h-3.5 w-3.5" /> 重启
              </Button>
              {!bridge ? (
                <span className="text-[11px] text-muted-foreground/60">浏览器模式下不可用，请在桌面应用中使用</span>
              ) : null}
            </div>
          </div>
        </Card>

        {settings ? <GitSettingsCard settings={settings} onSaved={setSettings} /> : null}

        <Card>
          <SectionTitle hint="实时生效" action={<Button size="xs" variant="ghost" onClick={() => setThemePanelOpen(true)}>全部选项</Button>}>
            外观
          </SectionTitle>
          <div className="mt-3">
            <Row label="主题色" hint="7 套预设，支持 7 种强调色与深浅模式">
              <div className="flex items-center gap-1">
                {THEMES.map((theme) => (
                  <Tooltip key={theme.id} content={theme.name}>
                    <button
                      onClick={() => setAppearance({ theme: theme.id })}
                      className={cn(
                        'h-5 w-5 rounded-full border transition-transform hover:scale-110',
                        appearance.theme === theme.id ? 'ring-2 ring-primary ring-offset-2 ring-offset-card' : 'border-white/20',
                      )}
                      style={{ backgroundImage: `linear-gradient(135deg, ${theme.from}, ${theme.to})` }}
                    />
                  </Tooltip>
                ))}
              </div>
            </Row>
            <Row label="明暗模式">
              <Segmented<'dark' | 'light'>
                size="sm"
                value={appearance.mode}
                onChange={(mode) => setAppearance({ mode })}
                options={[
                  { value: 'dark', label: '深色' },
                  { value: 'light', label: '浅色' },
                ]}
              />
            </Row>
            <Row label="界面密度">
              <Segmented<'cozy' | 'compact'>
                size="sm"
                value={appearance.density}
                onChange={(density) => setAppearance({ density })}
                options={[
                  { value: 'cozy', label: '宽松' },
                  { value: 'compact', label: '紧凑' },
                ]}
              />
            </Row>
          </div>
        </Card>

        <Card>
          <SectionTitle hint="TSD Agent">关于</SectionTitle>
          <div className="mt-3 space-y-2 text-[11.5px] text-muted-foreground">
            <div className="flex items-center gap-2">
              <Info className="h-3.5 w-3.5" />
              <span>版本</span>
              <span className="ml-auto font-mono">{health?.version || bridge?.version || '1.0.0'}</span>
            </div>
            <div className="flex items-center gap-2">
              <Cpu className="h-3.5 w-3.5" />
              <span>平台</span>
              <span className="ml-auto font-mono">{bridge?.platform || navigator.platform}</span>
            </div>
            <div className="flex items-center gap-2">
              <Database className="h-3.5 w-3.5" />
              <span>工作目录</span>
              <span className="ml-auto max-w-[60%] truncate font-mono">{health?.workspace || '—'}</span>
            </div>
            <div className="flex items-center gap-2">
              <Zap className="h-3.5 w-3.5" />
              <span>运行时长</span>
              <span className="ml-auto font-mono">{health ? `${Math.round(health.uptimeSec)}s` : '—'}</span>
            </div>
            <div className="flex flex-wrap items-center gap-2 pt-2">
              <Button
                size="xs"
                variant="secondary"
                className="gap-1"
                onClick={() => window.tsd?.openExternal('https://github.com/vconlln/TSD-agent')}
              >
                <Github className="h-3 w-3" /> GitHub 仓库
              </Button>
              <Button
                size="xs"
                variant="ghost"
                className="gap-1"
                onClick={() => window.tsd?.openExternal('https://github.com/vconlln/TSD-agent/blob/main/docs/API.md')}
              >
                <ExternalLink className="h-3 w-3" /> 后端接口文档
              </Button>
              <span className="ml-auto flex items-center gap-1 text-[10.5px] text-muted-foreground/60">
                <Sparkles className="h-2.5 w-2.5" /> Electron + React + FastAPI
              </span>
            </div>
          </div>
        </Card>
      </div>
    </div>
  )
}
