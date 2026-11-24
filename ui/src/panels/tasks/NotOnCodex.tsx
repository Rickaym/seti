import { Hint } from '@/components/Hint'

/** A feature the agent's runtime does not have, said quietly with the reason in its tooltip. */
export function NotOnRuntime({ label, reason }: { label: string; reason: string }) {
  return (
    <Hint text={reason}>
      <span className="text-muted-foreground">Not on {label}</span>
    </Hint>
  )
}

/** A feature a Codex agent does not have. */
export function NotOnCodex({ reason }: { reason: string }) {
  return <NotOnRuntime label="Codex" reason={reason} />
}

export const NO_BYPASS = 'Codex agents ask before every command and edit; Bypass is not offered.'
