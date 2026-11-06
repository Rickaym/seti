import { Blocks } from 'lucide-react'
import { StatusBarItem } from '@/components/status-bar/StatusBarItem'
import { mcpTone } from '@/components/status-bar/tone'
import { useCapabilitySummary } from '@/hooks/useSummaries'
import { navigate } from '@/lib/route'

export function McpItem() {
  const { data } = useCapabilitySummary()
  if (!data) {
    return null
  }
  const { connected, failed } = data.servers
  const needsAuth = data.servers['needs-auth']
  const total = Object.values(data.servers).reduce((sum, n) => sum + n, 0)
  return (
    <StatusBarItem
      label="MCP servers"
      name="MCP"
      tone={mcpTone(data)}
      tooltip={
        <span>
          {connected} of {total} MCP servers connected, {data.tools} tools.
          {needsAuth > 0 && (
            <>
              <br />
              {needsAuth} need authentication.
            </>
          )}
          {failed > 0 && (
            <>
              <br />
              {failed} failed to connect.
            </>
          )}
          <br />
          Checked {new Date(data.probed_at).toLocaleTimeString()}. Click for MCP servers.
        </span>
      }
      onClick={() => {
        navigate('settings', 'mcp')
      }}
    >
      <Blocks className="size-3" />
      <span>
        {connected}/{total}
      </span>
    </StatusBarItem>
  )
}
