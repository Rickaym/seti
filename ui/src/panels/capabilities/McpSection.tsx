import { localServerNote, type McpServer } from '@seti/shared'
import { Plus } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { Hint } from '@/components/Hint'
import { Button } from '@/components/ui/button'
import { DefaultSwitch } from '@/panels/access/DefaultSwitch'
import { useMcpSelection } from '@/panels/mcp/selection'
import { McpAuthDialog } from './McpAuthDialog'
import { McpServerDialog } from './McpServerDialog'
import { EmptyRow, Section } from './Section'
import { ServerActions } from './ServerActions'
import { ServerList } from './ServerList'
import type { ServerView } from './filter'

export function McpSection({
  views,
  searching,
  repoId,
  onReload,
  onRefresh,
}: {
  views: ServerView[]
  searching: boolean
  repoId: string | undefined
  onReload: () => void
  onRefresh: () => void
}) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  const [adding, setAdding] = useState(false)
  const [signingIn, setSigningIn] = useState<McpServer | null>(null)
  const selection = useMcpSelection()
  const entries = new Map((selection.entries ?? []).map((entry) => [entry.name, entry]))

  const toggle = (name: string) => {
    const next = new Set(expanded)
    if (!next.delete(name)) {
      next.add(name)
    }
    setExpanded(next)
  }

  return (
    <>
      <Section
        title="MCP servers"
        count={views.length}
        actions={
          <Hint text="Add an MCP server with claude mcp add">
            <Button
              type="button"
              variant="outline"
              size="xs"
              aria-label="Add MCP server"
              onClick={() => {
                setAdding(true)
              }}
            >
              <Plus />
              Add server
            </Button>
          </Hint>
        }
      >
        {views.length === 0 ? (
          <EmptyRow>{searching ? 'No matching servers or tools.' : 'No MCP servers configured.'}</EmptyRow>
        ) : (
          <ServerList
            views={views}
            expanded={expanded}
            onToggle={toggle}
            onAuthenticate={setSigningIn}
            actions={(server) => {
              const entry = entries.get(server.name)
              const localTo = entry?.local_to ?? []
              return (
                <>
                  {localTo.length > 0 && (
                    <span className="mr-2 max-w-56 truncate text-2xs text-muted-foreground">
                      {localServerNote(localTo, entry?.default_enabled ?? false)}
                    </span>
                  )}
                  <DefaultSwitch
                    name={server.name}
                    enabled={entry?.default_enabled ?? true}
                    onChange={(enabled) => void selection.saveDefault(server.name, enabled)}
                  />
                  <ServerActions
                    server={server}
                    repoId={repoId}
                    onAuthenticate={() => {
                      setSigningIn(server)
                    }}
                    onReconnected={onReload}
                    onRemoved={onRefresh}
                  />
                </>
              )
            }}
          />
        )}
      </Section>
      {adding && (
        <McpServerDialog
          repoId={repoId}
          onClose={() => {
            setAdding(false)
          }}
          onSaved={(change) => {
            setAdding(false)
            toast.success(`Added ${change.name} to the ${change.scope} config`)
            onRefresh()
          }}
        />
      )}
      {signingIn !== null && (
        <McpAuthDialog
          serverName={signingIn.name}
          repoId={repoId}
          onClose={() => {
            setSigningIn(null)
          }}
          onDone={onRefresh}
        />
      )}
    </>
  )
}
