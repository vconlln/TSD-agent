import * as React from 'react'
import { Slot } from '@radix-ui/react-slot'
import { cva, type VariantProps } from 'class-variance-authority'
import * as SeparatorPrimitive from '@radix-ui/react-separator'
import { Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'

/* ------------------------------- Button ------------------------------- */

const buttonVariants = cva(
  'relative inline-flex select-none items-center justify-center gap-2 whitespace-nowrap rounded-lg text-[13.5px] font-medium transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/45 focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-45 active:translate-y-[0.5px]',
  {
    variants: {
      variant: {
        primary:
          'bg-primary text-primary-foreground shadow-[var(--shadow-raised)] hover:brightness-[1.06]',
        secondary:
          'border border-border bg-secondary text-secondary-foreground hover:border-border hover:bg-accent hover:text-accent-foreground',
        outline:
          'border border-border bg-transparent text-foreground hover:border-primary/40 hover:bg-primary/[0.07]',
        ghost: 'text-muted-foreground hover:bg-accent hover:text-foreground',
        subtle: 'bg-primary/[0.1] text-primary hover:bg-primary/[0.16]',
        destructive: 'bg-destructive text-destructive-foreground hover:brightness-110',
        link: 'text-primary underline-offset-4 hover:underline',
      },
      size: {
        xs: 'h-7 gap-1.5 rounded-md px-2 text-[12.5px]',
        sm: 'h-8 px-3 text-[13px]',
        md: 'h-9 px-3.5',
        lg: 'h-11 rounded-xl px-5 text-[14px]',
        icon: 'h-9 w-9',
        'icon-sm': 'h-7 w-7 rounded-md',
      },
    },
    defaultVariants: { variant: 'secondary', size: 'md' },
  },
)

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean
  loading?: boolean
}

/** loading 时用它替换内容；不同尺寸给不同直径，避免视觉上忽然变大/变小 */
const SPINNER_CLASS: Record<string, string> = {
  xs: 'h-3 w-3',
  sm: 'h-3.5 w-3.5',
  md: 'h-3.5 w-3.5',
  lg: 'h-4 w-4',
  icon: 'h-3.5 w-3.5',
  'icon-sm': 'h-3 w-3',
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, loading, children, disabled, style, ...props }, ref) => {
    const Comp = asChild ? Slot : 'button'
    const gap = size === 'xs' || size === 'icon-sm' ? 'gap-1.5' : 'gap-2'
    // asChild 时 Radix Slot 只接受单个子元素，不能包 span / 叠 spinner，保持原样透传
    if (asChild) {
      return (
        <Comp ref={ref} {...props} className={cn(buttonVariants({ variant, size }), className)} disabled={disabled} style={style}>
          {children}
        </Comp>
      )
    }
    return (
      <Comp
        ref={ref}
        {...props}
        className={cn(buttonVariants({ variant, size }), className)}
        disabled={disabled || loading}
        aria-busy={loading || undefined}
        // 加载中保持原尺寸：内容只是「变透明」但仍然占位，转圈图标绝对定位居中覆盖，
        // 于是按钮宽高、周围布局都不会跳，原来的图标也不会被挤上去。
        style={{ ...style, ...(loading ? { opacity: 0.9 } : null) }}
      >
        <span className={cn('inline-flex min-w-0 items-center justify-center', gap, loading && 'invisible')}>
          {children}
        </span>
        {loading ? (
          <span className="pointer-events-none absolute inset-0 grid place-items-center">
            <Loader2 className={cn('animate-spin', SPINNER_CLASS[size ?? 'md'] ?? 'h-3.5 w-3.5')} />
          </span>
        ) : null}
      </Comp>
    )
  },
)
Button.displayName = 'Button'

/* ------------------------------- Badge -------------------------------- */

const badgeVariants = cva(
  'inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[12px] font-medium leading-4 tabular',
  {
    variants: {
      variant: {
        default: 'border-primary/25 bg-primary/10 text-primary',
        outline: 'border-border bg-transparent text-muted-foreground',
        muted: 'border-transparent bg-muted text-muted-foreground',
        success: 'border-[hsl(var(--success)/0.3)] bg-[hsl(var(--success)/0.12)] text-[hsl(var(--success))]',
        warning: 'border-[hsl(var(--warning)/0.3)] bg-[hsl(var(--warning)/0.12)] text-[hsl(var(--warning))]',
        danger: 'border-[hsl(var(--destructive)/0.3)] bg-[hsl(var(--destructive)/0.12)] text-[hsl(var(--destructive))]',
        info: 'border-[hsl(var(--info)/0.3)] bg-[hsl(var(--info)/0.12)] text-[hsl(var(--info))]',
        gradient: 'border-primary/30 bg-primary text-primary-foreground',
      },
    },
    defaultVariants: { variant: 'default' },
  },
)

export function Badge({
  className,
  variant,
  ...props
}: React.HTMLAttributes<HTMLSpanElement> & VariantProps<typeof badgeVariants>) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />
}

/* ------------------------------- Inputs ------------------------------- */

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => (
    <input
      ref={ref}
      className={cn(
        'flex h-9 w-full rounded-lg border border-input bg-background/45 px-3 py-1.5 text-[13.5px] text-foreground shadow-[0_1px_0_0_hsl(var(--foreground)/0.03)_inset] outline-none transition-colors',
        'placeholder:text-muted-foreground/60 hover:border-border focus:border-primary/50 focus:bg-background/70 focus:ring-2 focus:ring-primary/15',
        'disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...props}
    />
  ),
)
Input.displayName = 'Input'

export const Textarea = React.forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(
  ({ className, ...props }, ref) => (
    <textarea
      ref={ref}
      className={cn(
        'flex min-h-[80px] w-full resize-none rounded-lg border border-input bg-background/45 px-3 py-2 text-[13.5px] leading-relaxed text-foreground outline-none transition-colors',
        'placeholder:text-muted-foreground/60 hover:border-border focus:border-primary/50 focus:bg-background/70 focus:ring-2 focus:ring-primary/15',
        'disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...props}
    />
  ),
)
Textarea.displayName = 'Textarea'

export function Label({ className, ...props }: React.LabelHTMLAttributes<HTMLLabelElement>) {
  return (
    <label
      className={cn('text-[12.5px] font-medium text-muted-foreground', className)}
      {...props}
    />
  )
}

export function Field({
  label,
  hint,
  children,
  className,
  htmlFor,
}: {
  label: string
  hint?: React.ReactNode
  children: React.ReactNode
  className?: string
  htmlFor?: string
}) {
  return (
    <div className={cn('space-y-2', className)}>
      <div className="flex items-baseline justify-between gap-3">
        <Label htmlFor={htmlFor}>{label}</Label>
        {hint ? <span className="text-[12px] text-muted-foreground/70">{hint}</span> : null}
      </div>
      {children}
    </div>
  )
}

/* ----------------------------- Indicators ----------------------------- */

export const Separator = React.forwardRef<
  React.ElementRef<typeof SeparatorPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof SeparatorPrimitive.Root>
>(({ className, orientation = 'horizontal', decorative = true, ...props }, ref) => (
  <SeparatorPrimitive.Root
    ref={ref}
    decorative={decorative}
    orientation={orientation}
    className={cn('shrink-0 bg-border', orientation === 'horizontal' ? 'h-px w-full' : 'h-full w-px', className)}
    {...props}
  />
))
Separator.displayName = 'Separator'

export function Spinner({ className, size = 14 }: { className?: string; size?: number }) {
  return <Loader2 className={cn('animate-spin text-muted-foreground', className)} style={{ width: size, height: size }} />
}

export function ProgressBar({
  value = 0,
  className,
  indeterminate,
  tone = 'primary',
}: {
  value?: number
  className?: string
  indeterminate?: boolean
  tone?: 'primary' | 'success' | 'warning' | 'danger'
}) {
  const pct = Math.max(0, Math.min(100, value))
  const toneCls =
    tone === 'success'
      ? 'bg-[hsl(var(--success))]'
      : tone === 'warning'
        ? 'bg-[hsl(var(--warning))]'
        : tone === 'danger'
          ? 'bg-destructive'
          : 'bg-primary'
  return (
    <div className={cn('relative h-1.5 w-full overflow-hidden rounded-full bg-muted', className)}>
      {/* 用 transform 而不是 width：动画不触发重排（gate 10a） */}
      <div
        className={cn('h-full w-full origin-left rounded-full transition-transform duration-500 ease-out', toneCls, indeterminate && 'shimmer-line w-1/2')}
        style={indeterminate ? undefined : { transform: 'scaleX(' + pct / 100 + ')' }}
      />
    </div>
  )
}

export function Skeleton({ className, style }: { className?: string; style?: React.CSSProperties }) {
  return <div className={cn('shimmer-line rounded-md bg-muted/60', className)} style={style} />
}

export function Kbd({ children, className }: { children: React.ReactNode; className?: string }) {
  return <kbd className={cn('kbd', className)}>{children}</kbd>
}

export function StatusDot({
  tone = 'idle',
  pulse = false,
  className,
}: {
  tone?: 'idle' | 'running' | 'success' | 'warning' | 'danger' | 'info'
  pulse?: boolean
  className?: string
}) {
  const color =
    tone === 'success'
      ? 'bg-[hsl(var(--success))]'
      : tone === 'danger'
        ? 'bg-destructive'
        : tone === 'warning'
          ? 'bg-[hsl(var(--warning))]'
          : tone === 'running'
            ? 'bg-primary'
            : tone === 'info'
              ? 'bg-[hsl(var(--info))]'
              : 'bg-muted-foreground/50'
  return (
    <span className={cn('relative inline-flex h-2 w-2 shrink-0 items-center justify-center', className)}>
      {pulse ? <span className={cn('absolute inset-0 animate-ping rounded-full opacity-60', color)} /> : null}
      <span className={cn('h-2 w-2 rounded-full', color)} />
    </span>
  )
}

/* --------------------------- Segmented control ------------------------ */

export function Segmented<T extends string>({
  value,
  onChange,
  options,
  className,
  size = 'md',
}: {
  value: T
  onChange: (value: T) => void
  options: Array<{ value: T; label: React.ReactNode; icon?: React.ReactNode; count?: number }>
  className?: string
  size?: 'sm' | 'md'
}) {
  return (
    <div
      className={cn(
        'inline-flex items-center gap-0.5 rounded-lg border border-border/80 bg-muted/40 p-0.5',
        className,
      )}
    >
      {options.map((opt) => {
        const active = opt.value === value
        return (
          <button
            key={opt.value}
            type="button"
            onClick={() => onChange(opt.value)}
            className={cn(
              'relative inline-flex items-center gap-1.5 rounded-[7px] font-medium transition-colors',
              size === 'sm' ? 'h-6 px-2 text-[12.5px]' : 'h-7 px-2.5 text-[13px]',
              active
                ? 'bg-card text-foreground shadow-[var(--shadow-raised)]'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {opt.icon}
            {opt.label}
            {typeof opt.count === 'number' && opt.count > 0 ? (
              <span className="tabular text-[11.5px] text-muted-foreground/80">{opt.count}</span>
            ) : null}
          </button>
        )
      })}
    </div>
  )
}

/* ------------------------------ Empty state --------------------------- */

export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
}: {
  icon?: React.ReactNode
  title: string
  description?: React.ReactNode
  action?: React.ReactNode
  className?: string
}) {
  return (
    <div className={cn('flex flex-col items-center justify-center gap-3 px-6 py-14 text-center', className)}>
      {icon ? (
        <div className="grid h-12 w-12 place-items-center rounded-2xl border border-border bg-muted/40 text-muted-foreground">
          {icon}
        </div>
      ) : null}
      <div className="space-y-1">
        <p className="text-[14px] font-medium text-foreground">{title}</p>
        {description ? <p className="max-w-sm text-[13px] leading-relaxed text-muted-foreground">{description}</p> : null}
      </div>
      {action}
    </div>
  )
}

export { buttonVariants, badgeVariants }
