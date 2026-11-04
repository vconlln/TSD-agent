import { cn } from '@/lib/utils'

export function LogoMark({ className, size = 28 }: { className?: string; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      className={cn('shrink-0', className)}
      aria-hidden="true"
    >
      {/* 单色印标：主色块 + 明度层次，不用渐变（gate 2a） */}
      <rect x="0.5" y="0.5" width="31" height="31" rx="8" fill="hsl(var(--primary))" />
      <rect x="0.5" y="0.5" width="31" height="31" rx="8" fill="hsl(var(--foreground) / 0.05)" />
      <rect x="0.5" y="0.5" width="31" height="31" rx="8" stroke="hsl(var(--foreground) / 0.14)" />
      <path
        d="M9.5 20.5L16 13.5L22.5 20.5"
        stroke="hsl(var(--primary-foreground))"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M9.5 25L16 18L22.5 25"
        stroke="hsl(var(--primary-foreground) / 0.5)"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="16" cy="8.4" r="1.6" fill="hsl(var(--primary-foreground))" />
    </svg>
  )
}

export function LogoLockup({ compact = false, className }: { compact?: boolean; className?: string }) {
  return (
    <div className={cn('flex items-center gap-2.5', className)}>
      <LogoMark size={compact ? 24 : 28} />
      {!compact && (
        <div className="leading-none">
          <span className="font-display text-base font-medium tracking-[-0.02em] text-foreground">TSD Agent</span>
          <div className="mt-1 text-2xs text-muted-foreground/60">项目升级工作台</div>
        </div>
      )}
    </div>
  )
}
