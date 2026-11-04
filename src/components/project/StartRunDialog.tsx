import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Play, Sparkles } from 'lucide-react'
import { toast } from 'sonner'
import type { Project } from '../../../shared/types'
import { useSessionStore } from '@/stores/session'
import { Button, Dialog, DialogContent, Field, Input, Textarea } from '@/components/ui'

export function StartRunDialog({
  project,
  open,
  onOpenChange,
}: {
  project: Project
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const navigate = useNavigate()
  const startRun = useSessionStore((s) => s.startRun)
  const runtime = useSessionStore((s) => s.runtimes[project.id])
  const lastPrompt = runtime?.runs[0]?.prompt
  const [request, setRequest] = useState('')
  const [version, setVersion] = useState(project.targetVersion)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (open) {
      setRequest(lastPrompt || project.description || '')
      setVersion(project.targetVersion)
    }
  }, [open, lastPrompt, project.description, project.targetVersion])

  const submit = async () => {
    if (!request.trim()) {
      toast.error('请填写升级方案')
      return
    }
    setBusy(true)
    try {
      await startRun(project.id, {
        upgradeRequest: request.trim(),
        targetVersion: version.trim() || undefined,
      })
      toast.success('升级任务已启动')
      onOpenChange(false)
      navigate(`/project/${project.id}?tab=overview`)
    } catch (err) {
      toast.error((err as Error).message || '启动失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title="执行升级"
        description={`Agent 将基于已有方案与代码，生成 UPDATE.md 与 v${version || project.targetVersion} 代码。`}
        className="w-[min(94vw,620px)]"
      >
        <div className="space-y-4 px-5 py-4">
          <div className="flex items-center gap-2 rounded-lg border border-primary/20 bg-primary/[0.06] px-3 py-2">
            <Sparkles className="h-3.5 w-3.5 shrink-0 text-primary" />
            <p className="text-[12.5px] leading-relaxed text-muted-foreground">
              流程：解析方案 → 下载代码 → 生成升级方案 → 升级代码 → 计算差异，可在项目页实时查看。
            </p>
          </div>
          <Field label="目标版本">
            <Input value={version} onChange={(e) => setVersion(e.target.value)} className="font-mono" placeholder="1.2.0" />
          </Field>
          <Field label="升级需求" hint="支持自然语言，越具体越好">
            <Textarea
              value={request}
              onChange={(e) => setRequest(e.target.value)}
              rows={7}
              placeholder="例如：将鉴权升级为 JWT + 刷新令牌，补充迁移脚本，保持旧接口兼容一个版本…"
            />
          </Field>
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-border/70 px-5 py-3">
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button variant="primary" size="sm" className="gap-1.5" loading={busy} onClick={() => void submit()}>
            <Play className="h-3.5 w-3.5" /> 开始执行
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
