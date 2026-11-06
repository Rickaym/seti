import type { ComponentProps, ReactElement, ReactNode } from 'react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

/** Explains a control whose visible label is kept to a word or two. */
export function Hint({
  text,
  side = 'bottom',
  children,
}: {
  text: ReactNode
  side?: ComponentProps<typeof TooltipContent>['side']
  children: ReactElement
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side={side} collisionPadding={8}>
        {text}
      </TooltipContent>
    </Tooltip>
  )
}
