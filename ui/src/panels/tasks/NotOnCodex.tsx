import { Hint } from '@/components/Hint'

/** A feature the agent's runtime does not have, said quietly with the reason in its tooltip. */
export function NotOnRuntime({ label, reason }: { label: string; reason: string }) {
  return (
    <Hint text={reason}>
      <span className="text-muted-foreground">Not on {label}</span>
    </Hint>
  )
}
