import { Globe, X } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { apiDelete, errorText } from '@/api'
import { Hint } from '@/components/Hint'
import { Button } from '@/components/ui/button'

/** Hosts the user allowed for this agent alone, beside the shared allowlist; each can go again. */
export function TaskHostsRow({
  taskId,
  hosts,
  onChanged,
}: {
  taskId: string
  hosts: readonly string[]
  onChanged: (hosts: string[]) => void
}) {
  const [busy, setBusy] = useState<string | null>(null)
  const remove = async (entry: string) => {
    setBusy(entry)
    try {
      await apiDelete(`/tasks/${taskId}/hosts/${encodeURIComponent(entry)}`)
      onChanged(hosts.filter((other) => other !== entry))
      toast.success(`${entry} removed`)
    } catch (e) {
      toast.error(errorText(e))
    } finally {
      setBusy(null)
    }
  }
  return (
    <section aria-label="Own hosts" className="flex min-w-0 flex-wrap items-center gap-2 text-xs">
      <Hint text="Hosts this agent alone reaches, beside the shared allowlist">
        <span className="flex items-center gap-1 text-2xs font-medium text-muted-foreground">
          <Globe className="size-3" aria-hidden />
          Hosts
        </span>
      </Hint>
      <ul className="flex min-w-0 flex-wrap gap-1">
        {hosts.map((entry) => (
          <li key={entry} className="flex min-w-0 items-center border border-border pl-1.5 text-2xs">
            <span className="truncate font-mono">{entry}</span>
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label={`Remove ${entry}`}
              disabled={busy === entry}
              className="text-muted-foreground pointer-coarse:size-9"
              onClick={() => void remove(entry)}
            >
              <X />
            </Button>
          </li>
        ))}
      </ul>
    </section>
  )
}
