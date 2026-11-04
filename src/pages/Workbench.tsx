import { useEffect, useMemo, useRef } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { motion } from 'framer-motion'
import {
  ArrowRight,
  BrainCircuit,
  Download,
  FileText,
  GitCompareArrows,
  Layers,
  Rocket,
  Sparkles,
  FolderKanban,
  Cpu,
  Copy,
} from 'lucide-react'
import { toast } from 'sonner'
import { useProjectsStore } from '@/stores/projects'
import { useAppStore } from '@/stores/app'
import { NewProjectForm } from '@/components/project/NewProjectForm'
import { ProjectCard } from '@/components/project/ProjectCard'
import { Badge, Button, EmptyState, Skeleton, Tooltip } from '@/components/ui'
import { PageHeader, SectionTitle } from '@/components/common/PageHeader'
import { copyText, formatRelative } from '@/lib/utils'

const STEPS = [
  { icon: FileText, title: '解析方案', desc: '抓取项目页面，提取结构并落成 Markdown' },
  { icon: Download, title: '下载代码', desc: '拉取仓库或压缩包到固定工作目录' },
  { icon: BrainCircuit, title: '生成升级方案', desc: '结合旧方案与需求产出 UPDATE.md' },
  { icon: GitCompareArrows, title: '升级代码 + 差异', desc: '输出新版本目录，并给出可视化差异' },
]

export function Workbench() {
  const projects = useProjectsStore((s) => s.projects)
  const loading = useProjectsStore((s) => s.loading)
  const load = useProjectsStore((s) => s.load)
  const remove = useProjectsStore((s) => s.remove)
  const health = useAppStore((s) => s.health)
  const [params] = useSearchParams()
  const formRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    if (params.get('new') === '1') {
      formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }
  }, [params])

  const stats = useMemo(() => {
    const ready = projects.filter((p) => p.status === 'ready').length
    const running = projects.filter((p) => p.status === 'running').length
    const files = projects.reduce((n, p) => n + (p.stats?.filesChanged ?? 0), 0)
    const lines = projects.reduce((n, p) => n + (p.stats?.added ?? 0) + (p.stats?.removed ?? 0), 0)
    return { ready, running, files, lines }
  }, [projects])

  const recent = projects.slice(0, 6)

  return (
    <div className="h-full overflow-y-auto scroll-area-thin">
      <div className="mx-auto w-full max-w-[1180px] px-6 pb-14 pt-7">
        <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.35 }}>
          <PageHeader
            eyebrow={
              <span className="flex items-center gap-1.5">
                <Rocket className="h-3 w-3 text-primary" /> 项目方案升级流水线
              </span>
            }
            title={
              <span className="block leading-[1.15]">
                输入项目名与升级方案
                <br />
                <span className="grad-text">其余交给 Agent 完成</span>
              </span>
            }
            description="自动解析方案网页、下载代码、生成 UPDATE.md、升级代码并给出完整差异。随时可与 Agent 对话继续调整。"
            actions={
              <>
                <Link to="/projects">
                  <Button variant="secondary" size="sm" className="gap-1.5">
                    <FolderKanban className="h-3.5 w-3.5" /> 项目库
                  </Button>
                </Link>
                <Button
                  variant="outline"
                  size="sm"
                  className="gap-1.5"
                  onClick={() => {
                    if (health?.workspace) {
                      void copyText(health.workspace).then(() => toast.success('已复制工作目录'))
                    }
                  }}
                >
                  <Layers className="h-3.5 w-3.5" /> 工作目录
                </Button>
              </>
            }
          />
        </motion.div>

        <div className="mt-6 grid gap-5 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
          <motion.div
            ref={formRef}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.35, delay: 0.05 }}
            className="grad-border relative overflow-hidden rounded-2xl border border-border/80 bg-card/60 p-5 shadow-panel backdrop-blur-xl"
          >
            <div className="mb-4 flex items-center gap-2">
              <span className="grid h-7 w-7 place-items-center rounded-lg bg-primary/12 text-primary">
                <Sparkles className="h-3.5 w-3.5" />
              </span>
              <div>
                <p className="text-[13.5px] font-semibold tracking-tight">新建升级任务</p>
                <p className="text-[12px] text-muted-foreground">创建后立即开始执行，无需手动点击每一步</p>
              </div>
              <Badge variant="muted" className="ml-auto">一键跑通</Badge>
            </div>
            <NewProjectForm />
          </motion.div>

          <div className="min-w-0 space-y-3">
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.35, delay: 0.1 }}
              className="panel min-w-0 p-3.5"
            >
              <SectionTitle hint="当前工作区概况">运行概览</SectionTitle>
              <div className="mt-3 grid grid-cols-2 gap-2">
                {[
                  { label: '已就绪项目', value: stats.ready, tone: 'text-foreground' },
                  { label: '执行中', value: stats.running, tone: 'text-primary' },
                  { label: '变更文件', value: stats.files, tone: 'text-foreground' },
                  { label: '代码行变更', value: stats.lines, tone: 'text-[hsl(var(--diff-add))]' },
                ].map((item) => (
                  <div key={item.label} className="rounded-lg border border-border/60 bg-background/30 px-2.5 py-2">
                    <div className="text-[11.5px] text-muted-foreground/60">{item.label}</div>
                    <div className={`stat-num mt-1 text-[19px] font-semibold leading-none ${item.tone}`}>{item.value}</div>
                  </div>
                ))}
              </div>
              <div className="mt-3 flex items-center gap-2 rounded-lg border border-border/50 bg-background/20 px-2.5 py-1.5">
                <Cpu className="h-3 w-3 shrink-0 text-muted-foreground/60" />
                <span className="truncate text-[12px] text-muted-foreground">
                  {health?.model || '未配置模型'} · {health?.engine === 'online' ? '在线' : '离线降级'}
                </span>
                <Tooltip content="复制工作目录">
                  <button
                    onClick={() => health?.workspace && void copyText(health.workspace).then(() => toast.success('已复制'))}
                    className="ml-auto grid h-5 w-5 shrink-0 place-items-center rounded text-muted-foreground/50 hover:bg-accent hover:text-foreground"
                  >
                    <Copy className="h-2.5 w-2.5" />
                  </button>
                </Tooltip>
              </div>
            </motion.div>

            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.35, delay: 0.15 }}
              className="panel p-3.5"
            >
              <SectionTitle hint="Agent 自动串联">流水线</SectionTitle>
              <div className="mt-3 space-y-2">
                {STEPS.map((step, idx) => (
                  <div key={step.title} className="flex items-start gap-2.5">
                    <div className="relative">
                      <span className="grid h-6 w-6 place-items-center rounded-lg border border-border/70 bg-background/40 text-muted-foreground">
                        <step.icon className="h-3 w-3" />
                      </span>
                      {idx < STEPS.length - 1 ? (
                        <span className="absolute left-1/2 top-6 h-[calc(100%+2px)] w-px bg-border/70" />
                      ) : null}
                    </div>
                    <div className="min-w-0 pb-1">
                      <p className="text-[12.5px] font-medium text-foreground/90">{step.title}</p>
                      <p className="text-[12px] leading-relaxed text-muted-foreground/70">{step.desc}</p>
                    </div>
                  </div>
                ))}
              </div>
            </motion.div>
          </div>
        </div>

        <div className="mt-8">
          <SectionTitle
            hint={recent.length ? `最近更新 ${formatRelative(recent[0]?.updatedAt)}` : undefined}
            action={
              projects.length > 0 ? (
                <Link to="/projects">
                  <Button variant="ghost" size="xs" className="gap-1">
                    全部项目 <ArrowRight className="h-2.5 w-2.5" />
                  </Button>
                </Link>
              ) : null
            }
          >
            最近项目
          </SectionTitle>

          {loading && recent.length === 0 ? (
            <div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {Array.from({ length: 3 }, (_, i) => (
                <Skeleton key={i} className="h-[150px] rounded-xl" />
              ))}
            </div>
          ) : recent.length === 0 ? (
            <div className="mt-3 rounded-2xl border border-dashed border-border/80 bg-card/25">
              <EmptyState
                icon={<FolderKanban className="h-5 w-5" />}
                title="还没有项目"
                description="在上方输入项目名与升级方案，Agent 会自动完成解析、下载、升级与差异生成。"
              />
            </div>
          ) : (
            <div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {recent.map((project, idx) => (
                <motion.div
                  key={project.id}
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.28, delay: 0.03 * idx }}
                >
                  <ProjectCard
                    project={project}
                    onDelete={async (id) => {
                      await remove(id)
                      toast.success('项目已删除')
                    }}
                  />
                </motion.div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
