/** The history of the checkout each worker's Seti reads its changelog from, oldest first. */
export const SOURCE_HISTORY = [
  { date: '2026-10-01T09:00:00Z', message: 'chore: seed' },
  { date: '2026-10-01T12:00:00Z', message: 'feat: start page (#1)' },
  { date: '2026-10-02T12:00:00Z', message: 'fix: login redirect (#2)' },
  { date: '2026-10-03T12:00:00Z', message: 'feat(ea): voice calls (#3)' },
  { date: '2026-10-04T10:00:00Z', message: 'docs: explain the readme' },
  { date: '2026-10-04T12:00:00Z', message: 'fix(ui): button size (#4)' },
  { date: '2026-10-05T12:00:00Z', message: 'perf: faster lists (#5)' },
  { date: '2026-10-06T12:00:00Z', message: 'feat: workspaces (#6)' },
  {
    date: '2026-10-07T12:00:00Z',
    message: 'fix(ea)!: keep tools within the limit (#7)\n\nThe EA went **quiet** on calls.',
  },
  { date: '2026-10-08T10:00:00Z', message: 'chore(deps): bump zod (#8)' },
  { date: '2026-10-08T12:00:00Z', message: 'feat: grid view (#9)' },
  { date: '2026-10-09T12:00:00Z', message: 'fix: retry a turn once (#10)' },
] as const

/** Commits on the origin's main that the checkout lacks, so an update is available. */
export const UPSTREAM_HISTORY = [
  { date: '2026-10-10T12:00:00Z', message: 'feat: dark mode (#11)' },
  { date: '2026-10-10T13:00:00Z', message: 'chore: tidy the readme' },
] as const
