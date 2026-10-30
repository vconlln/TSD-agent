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
  return (
    <div className={cn('flex flex-wrap items-start justify-between gap-4', className)}>
      <div className="min-w-0 space-y-1.5">
        {eyebrow ? (
          <div className="text-[10.5px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/60">{eyebrow}</div>
        ) : null}
        <h1 className="text-balance text-[22px] font-semibold leading-tight tracking-[-0.02em] text-foreground">{title}</h1>
        {description ? (
          <p className="max-w-2xl text-pretty text-[12.5px] leading-relaxed text-muted-foreground">{description}</p>
        ) : null}
        {children}
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
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
        <h2 className="text-[12px] font-semibold uppercase tracking-[0.1em] text-muted-foreground/80">{children}</h2>
        {hint ? <span className="text-[11px] text-muted-foreground/60">{hint}</span> : null}
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
          ? 'grad-text'
          : 'text-foreground'
  return (
    <div className={cn('panel grain-border relative overflow-hidden px-3.5 py-3', className)}>
      <div className="flex items-start justify-between gap-2">
        <span className="text-[10.5px] font-medium uppercase tracking-[0.1em] text-muted-foreground/70">{label}</span>
        {icon ? <span className="text-muted-foreground/50">{icon}</span> : null}
      </div>
      <div className={cn('stat-num mt-1.5 text-[22px] font-semibold leading-none', valueTone)}>{value}</div>
      {hint ? <div className="mt-1.5 text-[11px] text-muted-foreground/70">{hint}</div> : null}
    </div>
  )
}
