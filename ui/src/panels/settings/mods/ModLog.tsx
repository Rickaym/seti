import type { ModLogLine } from '@seti/shared'
import { ScrollText } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { apiGet, errorText } from '@/api'
import { Button } from '@/components/ui/button'

/** A third-party mod's newest log lines, read when the user asks for them. */
export function ModLog({ id }: { id: string }) {
  const [lines, setLines] = useState<ModLogLine[] | null>(null)
  if (lines === null) {
    return (
      <Button
        size="sm"
        variant="outline"
        onClick={() => {
          apiGet<ModLogLine[]>(`/mod-admin/mods/${id}/log`).then(setLines, (e: unknown) => {
            toast.error('Seti did not read the log', { description: errorText(e), duration: Infinity })
          })
        }}
      >
        <ScrollText />
        Log
      </Button>
    )
  }
  return (
    <ul
      aria-label="Log"
      className="max-h-64 space-y-0.5 overflow-y-auto border border-border bg-card p-2 font-mono text-[11px]"
    >
      {lines.length === 0 && <li className="text-muted-foreground">Nothing logged yet.</li>}
      {lines.map((line, i) => (
        <li key={`${line.at}-${String(i)}`} className={line.level === 'error' ? 'text-destructive' : undefined}>
          {line.at.slice(11, 19)} {line.line}
        </li>
      ))}
    </ul>
  )
}
