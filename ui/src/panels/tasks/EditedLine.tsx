import { Pencil } from 'lucide-react'
import { editMarkText, type EditMark } from '@/lib/edit-mark'

/** Says, under the call it marks, what the user edited and whether the call then went out. */
export function EditedLine({ mark }: { mark: EditMark }) {
  return (
    <p data-testid="edited-mark" className="flex items-start gap-2 text-xs text-muted-foreground">
      <Pencil className="mt-px size-3.5 shrink-0" aria-hidden />
      <span className="min-w-0">{editMarkText(mark)}</span>
    </p>
  )
}
