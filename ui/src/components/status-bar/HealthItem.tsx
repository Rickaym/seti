import { HeartPulse } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { useConnection, WAITING, type Connection } from '@/components/status-bar/connection'
import {
  apiTone,
  channelsTone,
  mcpTone,
  resourcesTone,
  RowContext,
  sandboxTone,
  TONE,
  worstTone,
  type StatusTone,
} from '@/components/status-bar/tone'
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet'
import { useResourceSummary } from '@/hooks/useResources'
import { useCapabilitySummary, useChannelsSummary } from '@/hooks/useSummaries'
import { useSystem } from '@/hooks/useSystem'
import { cn } from '@/lib/utils'

function useHealthTones(connection: Connection): StatusTone[] {
  const resources = useResourceSummary().data
  const mcp = useCapabilitySummary().data
  const channels = useChannelsSummary().data
  const sandbox = useSystem().data?.sandbox
  return [
    resources ? resourcesTone(resources) : 'default',
    mcp ? mcpTone(mcp) : 'default',
    channels ? channelsTone(channels) : 'default',
    apiTone(connection),
    sandbox ? sandboxTone(sandbox.enabled) : 'default',
  ]
}

/** On a phone the health items fold into one item that opens them as rows with their details. */
export function HealthItem({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false)
  const connection = useConnection().state
  const tones = useHealthTones(connection)
  const flagged = tones.filter((t) => t !== 'default' && t !== 'muted').length
  const waiting = WAITING[connection]
  const tone = waiting !== undefined && flagged === 0 ? 'muted' : worstTone(tones)
  const Icon = waiting?.icon ?? HeartPulse
  const label =
    flagged === 0 ? `Health: ${waiting?.text.toLowerCase() ?? 'all clear'}` : `Health: ${String(flagged)} to check`
  return (
    <>
      <button
        type="button"
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        data-tone={tone}
        onClick={() => {
          setOpen(true)
        }}
        className={cn(
          'flex h-full min-w-11 items-center justify-center gap-1.5 px-2 whitespace-nowrap outline-none focus-visible:bg-foreground/10',
          TONE[tone],
        )}
      >
        <Icon className="size-3" aria-hidden />
        {waiting?.text ?? 'Health'}
        {flagged > 0 && <span className="tabular-nums">{flagged}</span>}
      </button>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="bottom" className="max-h-[85dvh] gap-0 overflow-y-auto">
          <div className="border-b border-border px-4 py-3 pr-12">
            <SheetTitle>Health</SheetTitle>
            <SheetDescription>Resources, MCP servers, the Seti server, sandbox and permissions.</SheetDescription>
          </div>
          <RowContext
            value={{
              onPick: () => {
                setOpen(false)
              },
            }}
          >
            {children}
          </RowContext>
        </SheetContent>
      </Sheet>
    </>
  )
}
