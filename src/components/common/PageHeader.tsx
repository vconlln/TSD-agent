import { cn } from '@/lib/utils'

export function PageHeader({
  title,
  description,
  actions,
  eyebrow,
  className,
  children,
}: {
  title: React.ReactNode
  description?: React.ReactNode
  actions?: React.ReactNode
  eyebrow?: React.ReactNode
  className?: string
  children?: React.ReactNode
}) {
  // 标题自己起头，不再在 h1 上方放一行栏目名（gate 54）；
  // eyebrow 入参保留只为兼容调用方，不再渲染。
  void eyebrow
  return (
    <div className={cn('flex flex-wrap items-end justify-between gap-4', className)}>
      <div className="min-w-0 space-y-2">
        <h1 className="text-balance text-xl font-semibold leading-[1.2] tracking-[-0.02em] text-foreground">
          {title}
        </h1>
        {description ? (
          <p className="max-w-2xl text-pretty text-base leading-relaxed text-muted-foreground">{description}</p>
        ) : null}
        {children}
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2 pb-0.5">{actions}</div> : null}
    </div>
  )
}

export function SectionTitle({
  children,
  hint,
  action,
  className,
}: {
  children: React.ReactNode
  hint?: React.ReactNode
  action?: React.ReactNode
  className?: string
}) {
  return (
    <div className={cn('flex items-center justify-between gap-3', className)}>
      <div className="flex items-center gap-2">
        <h2 className="text-base font-semibold tracking-[-0.01em] text-foreground/90">{children}</h2>
        {hint ? <span className="text-xs text-muted-foreground/70">{hint}</span> : null}
      </div>
      {action}
    </div>
  )
}

export function MetricCard({
  label,
  value,
  hint,
  icon,
  tone = 'default',
  className,
}: {
  label: string
  value: React.ReactNode
  hint?: React.ReactNode
  icon?: React.ReactNode
  tone?: 'default' | 'add' | 'del' | 'primary'
  className?: string
}) {
  const valueTone =
    tone === 'add'
      ? 'text-[hsl(var(--diff-add))]'
      : tone === 'del'
        ? 'text-[hsl(var(--diff-del))]'
        : tone === 'primary'
          ? 'text-primary'
          : 'text-foreground'
  return (
    <div className={cn('panel grain-border relative overflow-hidden px-3.5 py-3', className)}>
      <div className="flex items-start justify-between gap-2">
        <span className="text-xs font-medium text-muted-foreground/70">{label}</span>
        {icon ? <span className="text-muted-foreground/50">{icon}</span> : null}
      </div>
      <div className={cn('font-display mt-1.5 text-lg font-semibold leading-none tabular', valueTone)}>{value}</div>
      {hint ? <div className="mt-1.5 text-xs text-muted-foreground/70">{hint}</div> : null}
    </div>
  )
}
