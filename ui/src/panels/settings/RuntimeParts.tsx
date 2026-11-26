import { DEFAULT_PROFILE_ID, type CodexState, type CodexStatus, type InstallFailure } from '@seti/shared'
import { CircleAlert, CircleCheck, CircleDashed, KeyRound, Loader2, RotateCw, type LucideIcon } from 'lucide-react'
import { Hint } from '@/components/Hint'
import { Button } from '@/components/ui/button'
import { navigate } from '@/lib/route'
import { cn } from '@/lib/utils'
import { SettingRow } from './layout'

/** What a runtime card shows of its status, the same for every runtime Seti installs. */
export type InstallStatus = Pick<CodexStatus, 'state' | 'failure' | 'pinned' | 'keyed' | 'keyElsewhere'>

/** How a card names its runtime, the program Seti installs, and the provider whose key it needs. */
export interface RuntimeWords {
  name: string
  program: string
  key: string
}

const STATES: Record<CodexState, { word: string; icon: LucideIcon }> = {
  off: { word: 'Off', icon: CircleDashed },
  installing: { word: 'Installing', icon: Loader2 },
  failed: { word: 'Failed', icon: CircleAlert },
  no_key: { word: 'No key', icon: KeyRound },
  ready: { word: 'Ready', icon: CircleCheck },
}

function stateHint(status: InstallStatus, words: RuntimeWords): string {
  switch (status.state) {
    case 'off':
      return `No agent can start on ${words.name} until you turn it on`
    case 'installing':
      return `Seti is installing ${words.program} ${status.pinned}`
    case 'failed':
      return status.failure?.message ?? `${words.program} cannot start`
    case 'no_key':
      return `The default credential, which new agents get, has no ${words.key} key yet`
    case 'ready':
      return `New agents can start on ${words.name}`
  }
}

export function StateWord({ status, words }: { status: InstallStatus; words: RuntimeWords }) {
  const { word, icon: Icon } = STATES[status.state]
  return (
    <Hint text={stateHint(status, words)}>
      <span
        role="status"
        className={cn(
          'flex items-center gap-1',
          status.state === 'failed' ? 'text-destructive' : 'text-muted-foreground',
        )}
      >
        <Icon className={cn('size-3.5', status.state === 'installing' && 'animate-spin')} />
        {word}
      </span>
    </Hint>
  )
}

const FAILURE_WORDS: Record<InstallFailure, string> = {
  network: 'Download failed',
  checksum: 'Checksum mismatch',
  platform: 'Unsupported machine',
  disk: 'Disk',
  missing: 'Not installed',
  program: 'Own program',
}

interface InstallRowProps {
  status: InstallStatus
  words: RuntimeWords
  busy: boolean
  retry: () => Promise<void>
}

/** While the runtime installs or after it failed: what happens, or why it stopped, with Retry. */
export function InstallRow({ status, words, busy, retry }: InstallRowProps) {
  if (status.state === 'installing') {
    return (
      <SettingRow
        label="Installing"
        description={`${words.program} ${status.pinned} from the npm registry; it runs only once both checksums match.`}
      >
        <Loader2 aria-hidden className="size-4 animate-spin text-muted-foreground" />
      </SettingRow>
    )
  }
  if (status.failure === null) {
    return null
  }
  return (
    <SettingRow label={FAILURE_WORDS[status.failure.reason]} stack description={status.failure.message}>
      <Hint text="Try the install or the check again">
        <Button variant="outline" size="sm" disabled={busy} onClick={() => void retry()}>
          <RotateCw />
          Retry
        </Button>
      </Hint>
    </SettingRow>
  )
}

/** Whether new agents get the provider's key, never a value, and where the user adds one. */
function keyLine(status: InstallStatus, words: RuntimeWords): string {
  if (status.keyed.includes(DEFAULT_PROFILE_ID)) {
    return 'New agents get the key in the default credential.'
  }
  if (status.keyElsewhere !== null) {
    return `Your connection ${status.keyElsewhere} holds a key but is not in the default credential; add it there in Connections.`
  }
  return `New agents get none yet: add your ${words.key} key in Connections, in the default credential.`
}

export function KeyRow({ status, words }: { status: InstallStatus; words: RuntimeWords }) {
  const keyed = status.keyed.includes(DEFAULT_PROFILE_ID)
  return (
    <SettingRow label={`${words.key} key`} stack description={keyLine(status, words)}>
      {keyed ? null : (
        <Hint text="Keys live in Connections; this page never changes them">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              navigate('settings', 'connections')
            }}
          >
            <KeyRound />
            Connections
          </Button>
        </Hint>
      )}
    </SettingRow>
  )
}
