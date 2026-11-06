import type { ProfileSummary } from '@seti/shared'
import { Switch } from '@/components/ui/switch'

/** One switch per credential: which bundles carry the connection. Off is the normal start. */
export function CredentialSwitches({
  connection,
  credentials,
  chosen,
  disabled = false,
  onToggle,
}: {
  connection: string
  credentials: readonly ProfileSummary[] | null
  chosen: ReadonlySet<string>
  disabled?: boolean
  onToggle: (id: string, on: boolean) => void
}) {
  if (credentials === null) {
    return <p className="p-3 text-xs text-muted-foreground">Loading...</p>
  }
  return (
    <ul aria-label="Credentials">
      {credentials.map((credential) => (
        <li
          key={credential.id}
          className="flex items-center justify-between gap-3 border-b border-border px-3 py-2 last:border-b-0"
        >
          <span className="min-w-0 truncate text-sm">{credential.name}</span>
          <Switch
            aria-label={`${connection} in ${credential.name}`}
            checked={chosen.has(credential.id)}
            disabled={disabled}
            onCheckedChange={(on) => {
              onToggle(credential.id, on)
            }}
          />
        </li>
      ))}
    </ul>
  )
}
