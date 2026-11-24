import { Hint } from '@/components/Hint'

/** A feature a Codex agent does not have, said quietly with the reason in its tooltip. */
export function NotOnCodex({ reason }: { reason: string }) {
  return (
    <Hint text={reason}>
      <span className="text-muted-foreground">Not on Codex</span>
    </Hint>
  )
}

export const NO_BYPASS = 'Codex agents ask before every command and edit; Bypass is not offered.'
