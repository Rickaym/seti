import { warmCacheSummary, type TaskSetup, type WarmCacheSeed } from '@seti/shared'

/** What the planner asked for at the start that the rules held back, one note per line. */
export function HeldBack({ setup }: { setup: TaskSetup }) {
  return (
    <ul aria-label="Held back" className="flex min-w-0 flex-col">
      {setup.withheld.map((note) => (
        <li key={note} className="break-words">
          {note}
        </li>
      ))}
    </ul>
  )
}

/** The planner did not answer, so the agent started with the defaults. */
export function PlannerFallback({ setup }: { setup: TaskSetup }) {
  return (
    <span aria-label="Planner" className="break-words">
      Started with the defaults
      {setup.fallback_reason === null ? '' : `: ${setup.fallback_reason}`}
    </span>
  )
}

function detail(seed: WarmCacheSeed): string {
  const from = seed.source_dir === null ? '' : ` from ${seed.source_dir}`
  const skipped = seed.skipped === 0 ? '' : `, ${String(seed.skipped)} skipped`
  return `${seed.repo}: ${seed.outcome}${from} in ${(seed.ms / 1000).toFixed(1)} s${skipped}`
}

/** What seeding copied into the agent's new worktrees, one repo per line. */
export function WarmCaches({ seeds }: { seeds: readonly WarmCacheSeed[] }) {
  const tried = seeds.filter((seed) => seed.outcome !== 'off' && seed.outcome !== 'empty')
  return (
    <ul aria-label="Warm caches" className="flex min-w-0 flex-col">
      {tried.map((seed) => (
        <li key={`${seed.repo} ${seed.source_dir ?? ''}`} title={detail(seed)} className="break-words">
          {tried.length === 1 ? warmCacheSummary(seed) : `${seed.repo}: ${warmCacheSummary(seed)}`}
        </li>
      ))}
    </ul>
  )
}
