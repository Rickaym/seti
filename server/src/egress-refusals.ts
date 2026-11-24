const FLUSH_MS = 5000

/**
 * Counts a task's refused hosts on the node and reports each: the first refusal at once, then
 * the running count at most every few seconds while refusals go on, so retries never flood it.
 */
export function refusalReporter(report: (host: string, count: number) => void): (host: string) => void {
  const counts = new Map<string, { count: number; timer: NodeJS.Timeout | null }>()
  return (host) => {
    const seen = counts.get(host)
    if (seen === undefined) {
      counts.set(host, { count: 1, timer: null })
      report(host, 1)
      return
    }
    seen.count += 1
    seen.timer ??= setTimeout(() => {
      seen.timer = null
      report(host, seen.count)
    }, FLUSH_MS).unref()
  }
}
