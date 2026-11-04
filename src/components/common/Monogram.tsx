import { cn } from '@/lib/utils'
import { initials } from '@/lib/utils'

/**
 * 项目字标：单色主色块 + 等宽字母，尺寸与字号成比例。
 * 以前是按 project.id 算出色相再拼渐变，浅色模式下几乎看不清，也溢出过小方框。
 */
export function Monogram({
  name,
  size = 24,
  className,
}: {
  name: string
  size?: number
  className?: string
}) {
  const text = initials(name)
  const font = Math.max(10, Math.round(size * 0.42))
  return (
    <span
      aria-hidden="true"
      className={cn(
        'grid shrink-0 place-items-center overflow-hidden rounded-md border border-primary/25 bg-primary/12 text-primary',
        className,
      )}
      style={{ width: size, height: size, fontSize: font, lineHeight: 1 }}
    >
      <span className="font-display font-semibold">{text}</span>
    </span>
  )
}
