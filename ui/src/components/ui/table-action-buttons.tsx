import { Loader2, Pencil, Trash2 } from 'lucide-react'
import type { ComponentProps } from 'react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

type IconActionProps = Omit<ComponentProps<typeof Button>, 'children'>

/** Neutral at rest so a row of actions stays calm; red only once pointed at or focused. */
export const DESTRUCTIVE_ON_INTENT =
  'hover:border-destructive/40 hover:bg-destructive/10 hover:text-destructive focus-visible:border-destructive/40 focus-visible:text-destructive dark:hover:bg-destructive/20'

export function EditIconButton({
  className,
  size = 'icon-xs',
  'aria-label': ariaLabel = 'Edit',
  title,
  ...props
}: IconActionProps) {
  return (
    <Button
      type="button"
      variant="outline"
      size={size}
      aria-label={ariaLabel}
      title={title ?? ariaLabel}
      className={cn(className)}
      {...props}
    >
      <Pencil className="size-3" aria-hidden />
    </Button>
  )
}

export function DeleteIconButton({
  className,
  size = 'icon-xs',
  loading,
  disabled,
  'aria-label': ariaLabel = 'Delete',
  title,
  ...props
}: IconActionProps & { loading?: boolean }) {
  const busy = loading === true
  const label = busy && ariaLabel === 'Delete' ? 'Deleting...' : ariaLabel
  return (
    <Button
      type="button"
      variant="outline"
      size={size}
      aria-label={label}
      title={title ?? label}
      className={cn(DESTRUCTIVE_ON_INTENT, className)}
      {...props}
      disabled={busy || disabled === true}
    >
      {busy ? <Loader2 className="size-3 animate-spin" aria-hidden /> : <Trash2 className="size-3" aria-hidden />}
    </Button>
  )
}
