import type { ReactNode } from 'react'
import { CopyIconButton } from '@/components/CopyButton'
import { cn } from '@/lib/utils'

/** Above the reply's top right corner on hover, or a row under it on touch screens. */
const REPLY_COPY = cn(
  'flex justify-end pointer-coarse:-mt-1',
  'pointer-fine:absolute pointer-fine:-top-1 pointer-fine:right-0 pointer-fine:opacity-0',
  'pointer-fine:group-hover/reply:opacity-100 pointer-fine:group-focus-within/reply:opacity-100',
  'pointer-fine:has-data-copied:opacity-100',
)

/** A rendered reply with a Copy reply action; `touch` false leaves it to hover on fine pointers. */
export function CopyReply({ text, touch = true, children }: { text: string; touch?: boolean; children: ReactNode }) {
  return (
    <div className="group/reply relative">
      {children}
      <div className={cn(REPLY_COPY, !touch && 'pointer-coarse:hidden')}>
        <CopyIconButton text={text} label="Copy reply" className="bg-background/90" />
      </div>
    </div>
  )
}
