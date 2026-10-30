import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowRight, FolderOpen, Globe2, GitBranch, FileArchive, Sparkles, Wand2 } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { useProjectsStore } from '@/stores/projects'
import { useSessionStore } from '@/stores/session'
import { Button, Field, Input, Textarea, Badge } from '@/components/ui'
import { Segmented } from '@/components/ui/core'

type SourceKind = 'page' | 'git' | 'zip' | 'local'

const SOURCE_META: Record<SourceKind, { label: string; icon: typeof Globe2; placeholder: string; hint: string }> = {
  page: {
    label: '方案网页',
    icon: Globe2,
    placeholder: 'https://example.com/project-plan',
    hint: '抓取该页面并解析为 Markdown 方案文档',
  },
  git: {
    label: 'Git 仓库',
    icon: GitBranch,
    placeholder: 'https://github.com/user/repo.git',
    hint: '克隆仓库到工作目录作为基础代码',
  },
  zip: {
    label: '压缩包',
    icon: FileArchive,
    placeholder: 'https://example.com/project.zip',
    hint: '下载并解压代码压缩包',
  },
  local: {
    label: '本地目录',
    icon: FolderOpen,
    placeholder: '选择本地项目目录…',
    hint: '复制本地已有代码作为基础版本',
  },
}

const PLAN_HINTS = [
  '把鉴权从 Session 升级为 JWT，并补充刷新令牌',
  '升级到 Spring Boot 3.2，替换废弃 API',
  '重构数据层，引入连接池与重试机制',
]

export function NewProjectForm({
  compact = false,
  onCreated,
}: {
  compact?: boolean
  onCreated?: () => void
}) {
  const navigate = useNavigate()
  const create = useProjectsStore((s) => s.create)
  const startRun = useSessionStore((s) => s.startRun)
  const [name, setName] = useState('')
  const [kind, setKind] = useState<SourceKind>('page')
  const [source, setSource] = useState('')
  const [targetVersion, setTargetVersion] = useState('')
  const [request, setRequest] = useState('')
  const [busy, setBusy] = useState(false)

  const meta = SOURCE_META[kind]

  const submit = async () => {
    if (!name.trim()) {
      toast.error('请填写项目名称')
      return
    }
    if (kind !== 'local' && !source.trim()) {
      toast.info('未填写方案来源，将基于内置脚手架继续执行')
    }
    setBusy(true)
    try {
      const project = await create({
        name: name.trim(),
        sourceUrl: source.trim() || undefined,
        sourceKind: kind,
        targetVersion: targetVersion.trim() || undefined,
      })
      onCreated?.()
      const prompt = request.trim() || `请基于现有方案完成 v${targetVersion || '1.1.0'} 升级`
      await startRun(project.id, { upgradeRequest: prompt, targetVersion: targetVersion.trim() || undefined })
      navigate(`/project/${project.id}?tab=overview`)
    } catch (err) {
      toast.error((err as Error).message || '创建项目失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-3.5">
      <div className="grid gap-3 sm:grid-cols-[1.4fr_1fr]">
        <Field label="项目名称" htmlFor="project-name" hint="必填">
          <Input
            id="project-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="例如：订单中心 / payment-gateway"
            autoFocus={!compact}
          />
        </Field>
        <Field label="目标版本" hint="可选">
          <Input
            value={targetVersion}
            onChange={(e) => setTargetVersion(e.target.value)}
            placeholder="1.2.0"
            className="font-mono"
          />
        </Field>
      </div>

      <div className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-[11.5px] font-medium uppercase tracking-[0.06em] text-muted-foreground">
            方案与代码来源 <span className="font-normal normal-case text-muted-foreground/50">可选</span>
          </span>
          <Segmented<SourceKind>
            size="sm"
            value={kind}
            onChange={(next) => {
              setKind(next)
              setSource('')
            }}
            options={(Object.keys(SOURCE_META) as SourceKind[]).map((key) => ({
              value: key,
              label: SOURCE_META[key].label,
              icon: (() => {
                const Icon = SOURCE_META[key].icon
                return <Icon className="h-3 w-3" />
              })(),
            }))}
          />
        </div>
        <div className="flex gap-2">
          <Input
            value={source}
            onChange={(e) => setSource(e.target.value)}
            placeholder={meta.placeholder}
            className="flex-1 font-mono text-[12px]"
          />
          {kind === 'local' ? (
            <Button
              variant="secondary"
              size="md"
              className="shrink-0 gap-1.5"
              onClick={async () => {
                const dir = await window.tsd?.pickDirectory('选择项目目录')
                if (dir) setSource(dir)
              }}
            >
              <FolderOpen className="h-3.5 w-3.5" /> 浏览
            </Button>
          ) : null}
        </div>
        <p className="flex items-center gap-1 text-[11px] text-muted-foreground/70">
          <Sparkles className="h-3 w-3 text-primary/70" /> {meta.hint}
        </p>
      </div>

      <Field label="升级方案（自然语言）" hint="Agent 将据此生成 UPDATE.md">
        <Textarea
          value={request}
          onChange={(e) => setRequest(e.target.value)}
          rows={compact ? 3 : 4}
          placeholder="描述本次升级的目标、范围与约束，例如：把用户鉴权升级为 JWT，新增刷新令牌接口，保留旧接口兼容一个版本…"
        />
      </Field>

      <div className="flex flex-wrap items-center gap-1.5">
        {PLAN_HINTS.map((hint) => (
          <button
            key={hint}
            onClick={() => setRequest((prev) => (prev ? `${prev}\n${hint}` : hint))}
            className={cn(
              'rounded-full border border-border/70 bg-card/40 px-2 py-0.5 text-[10.5px] text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground',
            )}
          >
            + {hint}
          </button>
        ))}
        <Badge variant="muted" className="ml-auto gap-1">
          <Wand2 className="h-2.5 w-2.5" /> 全流程自动执行
        </Badge>
      </div>

      <Button variant="primary" size="lg" className="w-full gap-2" onClick={() => void submit()} loading={busy} disabled={busy}>
        创建并自动执行
        <ArrowRight className="h-4 w-4" />
      </Button>
      <p className="text-center text-[10.5px] leading-relaxed text-muted-foreground/60">
        解析方案 → 下载代码 → 生成 UPDATE.md → 升级代码 → 输出差异，全程可在项目页实时查看
      </p>
    </div>
  )
}
