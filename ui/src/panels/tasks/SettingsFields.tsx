import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

/** One labelled row of an agent settings tab. */
export function Row({ label, warn = false, children }: { label: string; warn?: boolean; children: ReactNode }) {
  return (
    <>
      <dt className="flex min-h-7 items-center self-start text-muted-foreground pointer-coarse:min-h-11">{label}</dt>
      <dd
        className={cn(
          'grid min-h-7 min-w-0 grid-cols-[minmax(0,1fr)] content-center break-all pointer-coarse:min-h-11 [&>button]:justify-self-start',
          warn && 'text-warning-text',
        )}
      >
        {children}
      </dd>
    </>
  )
}

/** One tab's rows, with a fixed label column so every tab lines up. */
export function Fields({ children }: { children: ReactNode }) {
  return (
    <dl className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-x-3 gap-y-2 text-xs max-md:grid-cols-[5.5rem_minmax(0,1fr)]">
      {children}
    </dl>
  )
}
