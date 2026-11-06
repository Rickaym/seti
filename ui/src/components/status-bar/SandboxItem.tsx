import type { GitHubTokenMode } from '@seti/shared'
import { ShieldCheck, ShieldOff } from 'lucide-react'
import { ItemHint, StatusBarItem } from '@/components/status-bar/StatusBarItem'
import { sandboxTone } from '@/components/status-bar/tone'
import { useSystem } from '@/hooks/useSystem'
import { navigate } from '@/lib/route'

const TOKEN: Record<GitHubTokenMode, string> = {
  agent: 'GitHub: the fine-grained token, added by the proxy.',
  none: 'GitHub: no token.',
}

export function SandboxItem() {
  const sandbox = useSystem().data?.sandbox
  if (sandbox === undefined) {
    return null
  }
  const { enabled } = sandbox
  const Icon = enabled ? ShieldCheck : ShieldOff
  return (
    <StatusBarItem
      label={enabled ? 'Sandbox on' : 'Sandbox off'}
      name="Sandbox"
      tone={sandboxTone(enabled)}
      tooltip={
        <ItemHint title={enabled ? 'Sandbox on' : 'Sandbox off'}>
          <span>
            {enabled
              ? 'Agents run sandboxed: no writes outside their directories, no credentials, only allowed hosts.'
              : 'Agent commands run with full access to this machine and the network.'}
          </span>
          {enabled && <span>{TOKEN[sandbox.token_mode]}</span>}
          <span>{enabled ? 'Click to change.' : 'Click to turn the sandbox on.'}</span>
        </ItemHint>
      }
      onClick={() => {
        navigate('settings', 'sandbox')
      }}
    >
      <Icon className="size-3" />
    </StatusBarItem>
  )
}
