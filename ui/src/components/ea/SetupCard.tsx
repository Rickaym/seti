import { EA_CREDENTIALS_DIR, EA_SERVICE_UNIT, eaKeyFile } from '@seti/shared'
import { RefreshCw, TriangleAlert } from 'lucide-react'
import type { ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import type { SetupNeed } from './useEaHealth'

function Code({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="space-y-1">
      <div className="text-2xs font-semibold tracking-wider text-muted-foreground uppercase">{label}</div>
      <pre className="overflow-x-auto border border-border bg-code/40 px-2.5 py-1.5 leading-relaxed">{children}</pre>
    </div>
  )
}

/** What to do before the EA can take a call: start the bot, or give it the keys it lacks. */
export function SetupCard({
  need,
  onCheck,
  blocked = 'take calls',
}: {
  need: SetupNeed
  onCheck: () => void
  /** What the missing keys stop the EA from doing. */
  blocked?: string
}) {
  const down = need.kind === 'down'
  return (
    <section className="space-y-3 border-b border-border px-3 py-3" aria-label="EA setup">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="flex items-center gap-1.5 font-semibold">
            <TriangleAlert className="size-3.5 shrink-0 text-warning-text" aria-hidden="true" />
            {down ? 'The EA is not running' : 'The EA needs a few keys'}
          </h2>
          <p className="mt-1 text-muted-foreground">
            {down
              ? `${need.reason}. It reads its keys from ${EA_CREDENTIALS_DIR}.`
              : `The EA is up but cannot ${blocked} until these files in ${EA_CREDENTIALS_DIR} hold its keys.`}
          </p>
        </div>
        <Button variant="outline" size="xs" onClick={onCheck}>
          <RefreshCw />
          Check again
        </Button>
      </div>
      {need.kind === 'keys' && <Code label="One key per file">{need.missing.map(eaKeyFile).join('\n')}</Code>}
      <Code label={down ? 'Enable and start the service' : 'Then restart it'}>
        {down ? `systemctl --user enable --now ${EA_SERVICE_UNIT}` : `systemctl --user restart ${EA_SERVICE_UNIT}`}
      </Code>
    </section>
  )
}
