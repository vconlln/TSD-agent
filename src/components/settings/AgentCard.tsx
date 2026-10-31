import { useEffect, useState } from 'react'
import { Bot, Gauge, Save, Terminal } from 'lucide-react'
import { toast } from 'sonner'
import type { AgentSettings, AppSettings } from '../../../shared/types'
import { api, ApiError } from '@/lib/api'
import { Badge, Button, Field, Input } from '@/components/ui'
import { Select, Switch } from '@/components/ui/overlays'
import { SectionTitle } from '@/components/common/PageHeader'

const MODES: Array<{ value: AgentSettings['mode']; label: string; hint: string }> = [
  { value: 'auto', label: '自动（推荐）', hint: '优先 function calling，模型不支持时自动降级为 JSON 协议' },
  { value: 'tools', label: '强制工具调用', hint: '仅当模型确定支持 tools 参数时使用' },
  { value: 'json', label: 'JSON 协议', hint: '老模型 / 纯文本补全模型也能用的降级协议' },
  { value: 'single', label: '单次生成', hint: '旧行为：一次性产出改动，不做验证（更快但更笨）' },
]

export function AgentCard({ settings, onSaved }: { settings: AppSettings; onSaved: (next: AppSettings) => void }) {
  const [agent, setAgent] = useState<AgentSettings>(
    settings.agent ?? {
      mode: 'auto',
      maxSteps: 24,
      allowCommands: true,
      verify: true,
      deadlineSeconds: 900,
      maxObservationChars: 6000,
    },
  )
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (settings.agent) setAgent(settings.agent)
  }, [settings.agent])

  const save = async () => {
    setSaving(true)
    try {
      const next = await api.updateSettings({ agent })
      onSaved(next)
      toast.success('Agent 配置已保存')
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  const agentic = agent.mode !== 'single'

  return (
    <div className="panel p-4">
      <SectionTitle
        hint="让模型自己读代码、改代码、跑验证"
        action={
          <Badge variant={agentic ? 'success' : 'outline'} className="gap-1">
            <Bot className="h-2.5 w-2.5" /> {agentic ? 'Agent 模式' : '单次生成'}
          </Badge>
        }
      >
        Agent 模式
      </SectionTitle>

      <div className="mt-3 space-y-3">
        <Field label="执行模式" hint={MODES.find((mode) => mode.value === agent.mode)?.hint}>
          <Select
            value={agent.mode}
            onValueChange={(mode) => setAgent({ ...agent, mode: mode as AgentSettings['mode'] })}
            options={MODES.map((mode) => ({ value: mode.value, label: mode.label, hint: mode.hint }))}
          />
        </Field>

        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="最大步骤" hint="每步一次模型决策">
            <Input
              type="number"
              min={2}
              max={80}
              value={agent.maxSteps}
              onChange={(e) => setAgent({ ...agent, maxSteps: Number(e.target.value) || 24 })}
            />
          </Field>
          <Field label="总时长上限（秒）" hint="超时自动收尾">
            <Input
              type="number"
              min={60}
              max={7200}
              value={agent.deadlineSeconds}
              onChange={(e) => setAgent({ ...agent, deadlineSeconds: Number(e.target.value) || 900 })}
            />
          </Field>
          <Field label="单次观察上限" hint="工具输出截断字符数">
            <Input
              type="number"
              min={1000}
              max={20000}
              step={500}
              value={agent.maxObservationChars}
              onChange={(e) => setAgent({ ...agent, maxObservationChars: Number(e.target.value) || 6000 })}
            />
          </Field>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border/50 bg-background/25 px-2.5 py-2">
          <div className="flex items-center gap-2">
            <Terminal className="h-3.5 w-3.5 text-muted-foreground" />
            <div>
              <p className="text-[12px] font-medium">允许运行验证命令</p>
              <p className="text-[10.5px] text-muted-foreground">
                白名单内的构建/测试命令（npm、pytest、go、cargo、tsc、ruff 等），带超时与输出上限
              </p>
            </div>
          </div>
          <Switch checked={agent.allowCommands} onCheckedChange={(allowCommands) => setAgent({ ...agent, allowCommands })} />
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border/50 bg-background/25 px-2.5 py-2">
          <div className="flex items-center gap-2">
            <Gauge className="h-3.5 w-3.5 text-muted-foreground" />
            <div>
              <p className="text-[12px] font-medium">改完自动跑测试</p>
              <p className="text-[10.5px] text-muted-foreground">
                探测 package.json scripts.test / pytest / go test / cargo test，失败会把错误回喂给模型修复
              </p>
            </div>
          </div>
          <Switch checked={agent.verify} onCheckedChange={(verify) => setAgent({ ...agent, verify })} />
        </div>

        <div className="flex items-center gap-2">
          <Button size="sm" variant="primary" className="gap-1.5" loading={saving} onClick={() => void save()}>
            <Save className="h-3.5 w-3.5" /> 保存 Agent 配置
          </Button>
          <span className="text-[11px] text-muted-foreground/60">
            Agent 每次调用工具都会写入「Agent 轨迹」标签页，可逐步回放
          </span>
        </div>
      </div>
    </div>
  )
}
