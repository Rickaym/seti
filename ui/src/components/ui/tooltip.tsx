'use client'

import { Tooltip as TooltipPrimitive } from 'radix-ui'
import * as React from 'react'
import { Z_PORTAL_POPOVER } from '@/lib/stacking'
import { cn } from '@/lib/utils'

function TooltipProvider({ delayDuration = 0, ...props }: React.ComponentProps<typeof TooltipPrimitive.Provider>) {
  return <TooltipPrimitive.Provider data-slot="tooltip-provider" delayDuration={delayDuration} {...props} />
}

/** Closes on a route change too, since focus stays on a trigger that stays on screen. */
function Tooltip({ onOpenChange, ...props }: Omit<React.ComponentProps<typeof TooltipPrimitive.Root>, 'open'>) {
  const [open, setOpen] = React.useState(false)
  React.useEffect(() => {
    if (!open) {
      return undefined
    }
    const close = () => {
      setOpen(false)
    }
    window.addEventListener('hashchange', close)
    return () => {
      window.removeEventListener('hashchange', close)
    }
  }, [open])
  return (
    <TooltipPrimitive.Root
      data-slot="tooltip"
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        onOpenChange?.(next)
      }}
      {...props}
    />
  )
}

/** Focus handed back by a closing popover or dialog comes from no element still on the page. */
const handedBack = (event: React.FocusEvent) =>
  !(event.relatedTarget instanceof Node && event.relatedTarget.isConnected)

function TooltipTrigger({ onFocus, ...props }: React.ComponentProps<typeof TooltipPrimitive.Trigger>) {
  return (
    <TooltipPrimitive.Trigger
      data-slot="tooltip-trigger"
      onFocus={(event) => {
        onFocus?.(event)
        if (handedBack(event)) {
          event.preventDefault()
        }
      }}
      {...props}
    />
  )
}

function TooltipContent({
  className,
  sideOffset = 0,
  children,
  style,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Content>) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        data-slot="tooltip-content"
        sideOffset={sideOffset}
        style={{ zIndex: Z_PORTAL_POPOVER, ...style }}
        className={cn(
          'inline-flex w-fit max-w-xs origin-(--radix-tooltip-content-transform-origin) items-center gap-1.5 rounded-none bg-foreground px-3 py-1.5 text-xs text-background has-data-[slot=kbd]:pr-1.5 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 **:data-[slot=kbd]:relative **:data-[slot=kbd]:isolate **:data-[slot=kbd]:z-50 **:data-[slot=kbd]:rounded-none data-[state=delayed-open]:animate-in data-[state=delayed-open]:fade-in-0 data-[state=delayed-open]:zoom-in-95 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95',
          className,
        )}
        {...props}
      >
        {children}
        <TooltipPrimitive.Arrow className="z-50 size-2.5 translate-y-[calc(-50%_-_2px)] rotate-45 rounded-none bg-foreground fill-foreground" />
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  )
}

export { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger }
