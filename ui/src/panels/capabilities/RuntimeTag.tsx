import type { StoredRuntime } from '@seti/shared'
import { Hint } from '@/components/Hint'
import { useRuntimesThat } from '@/hooks/useCapabilities'
import { useRuntimes } from '@/hooks/useRuntimes'
import { runtimeTag } from '@/lib/runtime-tag'

/** A quiet tag for a row some of the runtimes that are on cannot use, with why in its tooltip. */
export function RuntimeTag({ usable, why }: { usable: readonly StoredRuntime[] | undefined; why?: string }) {
  const { data } = useRuntimes()
  const on = data?.offers.map((offer) => offer.runtime) ?? []
  const tag = usable === undefined ? null : runtimeTag(usable, on)
  if (tag === null) {
    return null
  }
  return (
    <Hint text={why ?? `${tag.missing} agents cannot use this.`}>
      <span className="shrink-0 text-2xs whitespace-nowrap text-muted-foreground">{tag.label}</span>
    </Hint>
  )
}

/** The tag of what a plugin brings: only runtimes that load plugins can use it. */
export function PluginTag() {
  return <RuntimeTag usable={useRuntimesThat((caps) => caps.plugins)} />
}
