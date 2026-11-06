import { isRemovableScope, type McpServer } from '@seti/shared'
import { KeyRound, Loader2, RotateCw } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { apiDelete, apiPost, errorText } from '@/api'
import { Hint } from '@/components/Hint'
import { Button } from '@/components/ui/button'
import { useConfirm } from '@/components/ui/confirm-context'
import { DeleteIconButton } from '@/components/ui/table-action-buttons'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

function removeBlocker(server: McpServer, repoId: string | undefined): string | null {
  if (server.scope === 'dynamic' || server.source === 'plugin') {
    return 'Provided by a plugin. Disable or uninstall the plugin with /plugin to remove it.'
  }
  if (server.scope === 'claudeai' || server.transport?.type === 'claudeai-proxy') {
    return 'A claude.ai connector. Manage it in claude.ai Settings > Connectors.'
  }
  if (!isRemovableScope(server.scope)) {
    return 'Configured outside the user, local and project config files, so claude mcp remove cannot change it.'
  }
  if (server.scope === 'project' && repoId === undefined) {
    return 'A project server. Switch the scope to its repo to remove it.'
  }
  return null
}

const serverPath = (server: McpServer) => `/mcp/${encodeURIComponent(server.name)}`

function RemoveButton({
  server,
  repoId,
  onRemoved,
}: {
  server: McpServer
  repoId: string | undefined
  onRemoved: () => void
}) {
  const confirm = useConfirm()
  const [busy, setBusy] = useState(false)
  const blocker = removeBlocker(server, repoId)
  const scope = server.scope ?? ''

  const remove = async () => {
    const message = `Remove ${server.name} from the ${scope} config? This runs claude mcp remove.`
    if (!(await confirm({ title: 'Remove MCP server', message, confirmLabel: 'Remove', variant: 'destructive' }))) {
      return
    }
    setBusy(true)
    try {
      const params = new URLSearchParams({
        scope,
        ...(scope !== 'user' && repoId !== undefined && { repo_id: repoId }),
      })
      await apiDelete(`/mcp/servers/${encodeURIComponent(server.name)}?${params.toString()}`)
      toast.success(`Removed ${server.name}`)
      onRemoved()
    } catch (e) {
      toast.error(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  const button = (
    <DeleteIconButton
      aria-label={blocker === null ? `Remove ${server.name}` : `Cannot remove ${server.name}`}
      title={blocker === null ? `Remove ${server.name}` : undefined}
      loading={busy}
      disabled={blocker !== null}
      onClick={() => void remove()}
    />
  )
  if (blocker === null) {
    return button
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex">{button}</span>
      </TooltipTrigger>
      <TooltipContent side="left">{blocker}</TooltipContent>
    </Tooltip>
  )
}

export function ServerActions({
  server,
  repoId,
  onAuthenticate,
  onReconnected,
  onRemoved,
}: {
  server: McpServer
  repoId: string | undefined
  onAuthenticate: () => void
  onReconnected: () => void
  onRemoved: () => void
}) {
  const [reconnecting, setReconnecting] = useState(false)

  const reconnect = async () => {
    setReconnecting(true)
    try {
      const next = await apiPost<McpServer>(
        `${serverPath(server)}/reconnect`,
        repoId === undefined ? {} : { repo_id: repoId },
      )
      const detail = next.error === null ? '' : `: ${next.error}`
      const notify = next.status === 'connected' ? toast.success : toast.warning
      notify(`${server.name} is ${next.status}${detail}`)
      onReconnected()
    } catch (e) {
      toast.error(errorText(e))
    } finally {
      setReconnecting(false)
    }
  }

  return (
    <span className="flex items-center gap-1">
      {server.sign_in === 'again' && (
        <Hint text={`Sign in to ${server.name} again through its OAuth page`} side="left">
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={`Sign in to ${server.name} again`}
            className="text-muted-foreground"
            onClick={onAuthenticate}
          >
            <KeyRound />
          </Button>
        </Hint>
      )}
      <Hint text="Reconnect: start a fresh Claude Code session and check every server again" side="left">
        <Button
          type="button"
          variant="outline"
          size="icon-xs"
          aria-label={`Reconnect ${server.name}`}
          disabled={reconnecting}
          onClick={() => void reconnect()}
        >
          {reconnecting ? <Loader2 className="animate-spin" /> : <RotateCw />}
        </Button>
      </Hint>
      <RemoveButton server={server} repoId={repoId} onRemoved={onRemoved} />
    </span>
  )
}
