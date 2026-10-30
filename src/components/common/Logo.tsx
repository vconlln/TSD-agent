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
      <defs>
        <linearGradient id="tsd-logo-grad" x1="2" y1="1" x2="30" y2="31" gradientUnits="userSpaceOnUse">
          <stop stopColor="hsl(var(--grad-from))" />
          <stop offset="1" stopColor="hsl(var(--grad-to))" />
        </linearGradient>
        <linearGradient id="tsd-logo-sheen" x1="6" y1="2" x2="24" y2="18" gradientUnits="userSpaceOnUse">
          <stop stopColor="white" stopOpacity="0.35" />
          <stop offset="1" stopColor="white" stopOpacity="0" />
        </linearGradient>
      </defs>
      <rect x="0.5" y="0.5" width="31" height="31" rx="9" fill="url(#tsd-logo-grad)" />
      <rect x="0.5" y="0.5" width="31" height="31" rx="9" fill="url(#tsd-logo-sheen)" />
      <rect x="0.5" y="0.5" width="31" height="31" rx="9" stroke="white" strokeOpacity="0.18" />
      <path d="M9.5 20.5L16 13.5L22.5 20.5" stroke="white" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M9.5 25L16 18L22.5 25" stroke="white" strokeOpacity="0.45" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="16" cy="8.4" r="1.6" fill="white" />
    </svg>
  )
}

export function LogoLockup({ compact = false, className }: { compact?: boolean; className?: string }) {
  return (
    <div className={cn('flex items-center gap-2.5', className)}>
      <LogoMark size={compact ? 24 : 28} />
      {!compact && (
        <div className="leading-none">
          <div className="flex items-baseline gap-1.5">
            <span className="text-[15px] font-semibold tracking-tight text-foreground">TSD</span>
            <span className="text-[15px] font-medium tracking-tight text-muted-foreground">Agent</span>
          </div>
          <div className="mt-1 text-[9.5px] font-medium uppercase tracking-[0.16em] text-muted-foreground/60">
            project upgrader
          </div>
        </div>
      )}
    </div>
  )
}
