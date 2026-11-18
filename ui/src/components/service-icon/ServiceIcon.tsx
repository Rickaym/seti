import type { LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import { serviceMark } from './service-marks'

/** A service's brand mark in the text colour, or the given lucide icon when it has none. */
export function ServiceIcon({
  icon,
  fallback: Fallback,
  className,
}: {
  icon: string | null | undefined
  fallback: LucideIcon
  className?: string
}) {
  const path = serviceMark(icon)
  if (path === undefined) {
    return <Fallback className={cn('size-4 shrink-0', className)} aria-hidden />
  }
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      data-service-icon={icon}
      className={cn('size-4 shrink-0', className)}
      aria-hidden
    >
      <path d={path} />
    </svg>
  )
}
