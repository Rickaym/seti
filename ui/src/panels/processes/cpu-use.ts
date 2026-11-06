import { coresLabel, type CpuScope } from '@seti/shared'

/** What a scope uses in cores, against its cap: 1.4 of 3 cores, or 1.4 cores with no cap. */
export function cpuUseLabel(scope: CpuScope): string {
  const used = Math.round(scope.usage_percent / 10) / 10
  if (scope.quota_percent === null) {
    return `${String(used)} ${used === 1 ? 'core' : 'cores'}, no cap`
  }
  return `${String(used)} of ${coresLabel(scope.quota_percent)}`
}

/** How full the cap is, in percent; null with no cap. */
export function cpuFill(scope: CpuScope): number | null {
  return scope.quota_percent === null ? null : Math.min(100, (100 * scope.usage_percent) / scope.quota_percent)
}

const seconds = (usec: number) => {
  const s = usec / 1e6
  return s < 60 ? `${String(Math.round(s * 10) / 10)} s` : `${String(Math.round(s / 6) / 10)} min`
}

/**
 * A calm note for a scope the kernel holds at its cap: it goes on at that speed, which is the cap
 * doing its job, not a fault. Null while the scope was not held back during the last look.
 */
export function throttleHint(scope: CpuScope): { label: string; detail: string } | null {
  if (!scope.throttled_now || scope.quota_percent === null) {
    return null
  }
  const times = `${String(scope.nr_throttled)} ${scope.nr_throttled === 1 ? 'time' : 'times'}`
  return {
    label: `at its cap of ${coresLabel(scope.quota_percent)}`,
    detail: `It wants more CPU than its cap, so it runs slower. Held back ${times}, ${seconds(scope.throttled_usec)} in all, since it started.`,
  }
}
