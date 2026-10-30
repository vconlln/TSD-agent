import * as React from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import * as DropdownPrimitive from '@radix-ui/react-dropdown-menu'
import * as TooltipPrimitive from '@radix-ui/react-tooltip'
import * as PopoverPrimitive from '@radix-ui/react-popover'
import * as SelectPrimitive from '@radix-ui/react-select'
import * as SwitchPrimitive from '@radix-ui/react-switch'
import * as SliderPrimitive from '@radix-ui/react-slider'
import * as TabsPrimitive from '@radix-ui/react-tabs'
import * as ScrollAreaPrimitive from '@radix-ui/react-scroll-area'
import { Check, ChevronDown, X } from 'lucide-react'
import { cn } from '@/lib/utils'

/* ------------------------------- Tooltip ------------------------------ */

export const TooltipProvider = TooltipPrimitive.Provider

export function Tooltip({
  content,
  children,
  side = 'top',
  delay = 200,
}: {
  content: React.ReactNode
  children: React.ReactNode
  side?: 'top' | 'right' | 'bottom' | 'left'
  delay?: number
}) {
  if (!content) return <>{children}</>
  return (
    <TooltipPrimitive.Root delayDuration={delay}>
      <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content
          side={side}
          sideOffset={6}
          className="z-[80] max-w-xs rounded-md border border-border bg-popover px-2 py-1 text-[11.5px] text-popover-foreground shadow-float animate-fade-in"
        >
          {content}
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  )
}

/* -------------------------------- Dialog ------------------------------ */

export const Dialog = DialogPrimitive.Root
export const DialogTrigger = DialogPrimitive.Trigger
export const DialogClose = DialogPrimitive.Close

export function DialogContent({
  children,
  className,
  title,
  description,
  hideClose,
}: {
  children: React.ReactNode
  className?: string
  title?: React.ReactNode
  description?: React.ReactNode
  hideClose?: boolean
}) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="fixed inset-0 z-[70] bg-[hsl(var(--background)/0.65)] backdrop-blur-sm data-[state=open]:animate-fade-in" />
      <DialogPrimitive.Content
        className={cn(
          'fixed left-1/2 top-1/2 z-[71] w-[min(92vw,560px)] -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-2xl border border-border bg-popover/95 shadow-float backdrop-blur-xl focus:outline-none data-[state=open]:animate-fade-up',
          className,
        )}
      >
        {(title || description) && (
          <div className="border-b border-border/70 px-5 py-4">
            {title ? (
              <DialogPrimitive.Title className="text-[15px] font-semibold tracking-tight text-foreground">
                {title}
              </DialogPrimitive.Title>
            ) : null}
            {description ? (
              <DialogPrimitive.Description className="mt-1 text-[12.5px] text-muted-foreground">
                {description}
              </DialogPrimitive.Description>
            ) : null}
          </div>
        )}
        {children}
        {hideClose ? null : (
          <DialogPrimitive.Close className="absolute right-3.5 top-3.5 grid h-7 w-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground">
            <X className="h-4 w-4" />
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  )
}

/* ------------------------------ Dropdown ------------------------------ */

export const DropdownMenu = DropdownPrimitive.Root
export const DropdownMenuTrigger = DropdownPrimitive.Trigger

export function DropdownContent({
  children,
  className,
  align = 'end',
  sideOffset = 6,
}: {
  children: React.ReactNode
  className?: string
  align?: 'start' | 'center' | 'end'
  sideOffset?: number
}) {
  return (
    <DropdownPrimitive.Portal>
      <DropdownPrimitive.Content
        align={align}
        sideOffset={sideOffset}
        className={cn(
          'z-[75] min-w-[10rem] overflow-hidden rounded-xl border border-border bg-popover/97 p-1 shadow-float backdrop-blur-xl data-[state=open]:animate-fade-up',
          className,
        )}
      >
        {children}
      </DropdownPrimitive.Content>
    </DropdownPrimitive.Portal>
  )
}

export function DropdownItem({
  children,
  className,
  onSelect,
  danger,
  disabled,
}: {
  children: React.ReactNode
  className?: string
  onSelect?: () => void
  danger?: boolean
  disabled?: boolean
}) {
  return (
    <DropdownPrimitive.Item
      disabled={disabled}
      onSelect={onSelect}
      className={cn(
        'relative flex cursor-pointer select-none items-center gap-2 rounded-lg px-2 py-1.5 text-[12.5px] outline-none transition-colors data-[highlighted]:bg-accent data-[disabled]:pointer-events-none data-[disabled]:opacity-40',
        danger ? 'text-destructive data-[highlighted]:bg-destructive/10' : 'text-foreground',
        className,
      )}
    >
      {children}
    </DropdownPrimitive.Item>
  )
}

export function DropdownSeparator() {
  return <DropdownPrimitive.Separator className="my-1 h-px bg-border/80" />
}

export function DropdownLabel({ children }: { children: React.ReactNode }) {
  return (
    <DropdownPrimitive.Label className="px-2 py-1.5 text-[10.5px] font-medium uppercase tracking-[0.08em] text-muted-foreground/70">
      {children}
    </DropdownPrimitive.Label>
  )
}

/* ------------------------------- Popover ------------------------------ */

export const Popover = PopoverPrimitive.Root
export const PopoverTrigger = PopoverPrimitive.Trigger

export function PopoverContent({
  children,
  className,
  align = 'end',
  sideOffset = 8,
}: {
  children: React.ReactNode
  className?: string
  align?: 'start' | 'center' | 'end'
  sideOffset?: number
}) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        align={align}
        sideOffset={sideOffset}
        className={cn(
          'z-[76] w-72 rounded-xl border border-border bg-popover/97 p-3 shadow-float backdrop-blur-xl outline-none data-[state=open]:animate-fade-up',
          className,
        )}
      >
        {children}
      </PopoverPrimitive.Content>
    </PopoverPrimitive.Portal>
  )
}

/* -------------------------------- Select ------------------------------ */

export function Select({
  value,
  onValueChange,
  options,
  className,
  placeholder,
}: {
  value?: string
  onValueChange: (value: string) => void
  options: Array<{ value: string; label: string; hint?: string }>
  className?: string
  placeholder?: string
}) {
  return (
    <SelectPrimitive.Root value={value} onValueChange={onValueChange}>
      <SelectPrimitive.Trigger
        className={cn(
          'flex h-9 w-full items-center justify-between gap-2 rounded-lg border border-input bg-background/45 px-3 text-[13px] text-foreground outline-none transition-colors hover:border-border focus:border-primary/50 focus:ring-2 focus:ring-primary/15',
          className,
        )}
      >
        <SelectPrimitive.Value placeholder={placeholder} />
        <SelectPrimitive.Icon>
          <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
        </SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal>
        <SelectPrimitive.Content
          position="popper"
          sideOffset={6}
          className="z-[78] max-h-72 min-w-[var(--radix-select-trigger-width)] overflow-hidden rounded-xl border border-border bg-popover/97 p-1 shadow-float backdrop-blur-xl"
        >
          <SelectPrimitive.Viewport>
            {options.map((opt) => (
              <SelectPrimitive.Item
                key={opt.value}
                value={opt.value}
                className="relative flex cursor-pointer select-none items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-[12.5px] text-foreground outline-none data-[highlighted]:bg-accent"
              >
                <div className="flex flex-col">
                  <SelectPrimitive.ItemText>{opt.label}</SelectPrimitive.ItemText>
                  {opt.hint ? <span className="text-[10.5px] text-muted-foreground">{opt.hint}</span> : null}
                </div>
                <SelectPrimitive.ItemIndicator>
                  <Check className="h-3.5 w-3.5 text-primary" />
                </SelectPrimitive.ItemIndicator>
              </SelectPrimitive.Item>
            ))}
          </SelectPrimitive.Viewport>
        </SelectPrimitive.Content>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  )
}

/* -------------------------------- Switch ------------------------------ */

export function Switch({
  checked,
  onCheckedChange,
  disabled,
}: {
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  disabled?: boolean
}) {
  return (
    <SwitchPrimitive.Root
      checked={checked}
      disabled={disabled}
      onCheckedChange={onCheckedChange}
      className={cn(
        'relative inline-flex h-[22px] w-[38px] shrink-0 cursor-pointer items-center rounded-full border transition-colors focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-40',
        checked ? 'border-transparent bg-accent-grad' : 'border-border bg-muted',
      )}
    >
      <SwitchPrimitive.Thumb
        className={cn(
          'pointer-events-none block h-[16px] w-[16px] rounded-full bg-white shadow-sm transition-transform',
          checked ? 'translate-x-[19px]' : 'translate-x-[3px]',
        )}
      />
    </SwitchPrimitive.Root>
  )
}

/* -------------------------------- Slider ------------------------------ */

export function Slider({
  value,
  onValueChange,
  min = 0,
  max = 100,
  step = 1,
  className,
}: {
  value: number
  onValueChange: (value: number) => void
  min?: number
  max?: number
  step?: number
  className?: string
}) {
  return (
    <SliderPrimitive.Root
      value={[value]}
      min={min}
      max={max}
      step={step}
      onValueChange={(v) => onValueChange(v[0])}
      className={cn('relative flex h-5 w-full touch-none select-none items-center', className)}
    >
      <SliderPrimitive.Track className="relative h-1 w-full grow overflow-hidden rounded-full bg-muted">
        <SliderPrimitive.Range className="absolute h-full bg-accent-grad" />
      </SliderPrimitive.Track>
      <SliderPrimitive.Thumb className="block h-3.5 w-3.5 rounded-full border-2 border-primary bg-background shadow transition-transform hover:scale-110 focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none" />
    </SliderPrimitive.Root>
  )
}

/* --------------------------------- Tabs ------------------------------- */

export const Tabs = TabsPrimitive.Root

export function TabsList({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <TabsPrimitive.List
      className={cn('inline-flex h-9 items-center gap-1 rounded-lg border border-border/70 bg-muted/40 p-1', className)}
    >
      {children}
    </TabsPrimitive.List>
  )
}

export function TabsTrigger({
  value,
  children,
  className,
}: {
  value: string
  children: React.ReactNode
  className?: string
}) {
  return (
    <TabsPrimitive.Trigger
      value={value}
      className={cn(
        'inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-[12.5px] font-medium text-muted-foreground transition-colors hover:text-foreground',
        'data-[state=active]:bg-card data-[state=active]:text-foreground data-[state=active]:shadow-[0_1px_0_0_hsl(var(--foreground)/0.06)]',
        className,
      )}
    >
      {children}
    </TabsPrimitive.Trigger>
  )
}

export const TabsContent = TabsPrimitive.Content

/* ------------------------------ ScrollArea ---------------------------- */

export function ScrollArea({
  children,
  className,
  viewportClassName,
}: {
  children: React.ReactNode
  className?: string
  viewportClassName?: string
}) {
  return (
    <ScrollAreaPrimitive.Root className={cn('relative overflow-hidden', className)}>
      <ScrollAreaPrimitive.Viewport className={cn('h-full w-full', viewportClassName)}>
        {children}
      </ScrollAreaPrimitive.Viewport>
      <ScrollAreaPrimitive.Scrollbar
        orientation="vertical"
        className="flex w-2 touch-none select-none p-0.5 transition-opacity"
      >
        <ScrollAreaPrimitive.Thumb className="flex-1 rounded-full bg-border" />
      </ScrollAreaPrimitive.Scrollbar>
    </ScrollAreaPrimitive.Root>
  )
}
