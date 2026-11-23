import { dreamReport, type DreamReport } from '@seti/shared'
import { describeIssues } from '../http.js'
import type { DreamTool } from '../runtimes/adapter.js'
import { redactSecrets } from '../scrub.js'
import { DREAM_REPORT, DREAM_SERVER } from './gate.js'

const redacted = (report: DreamReport): DreamReport => ({
  summary: redactSecrets(report.summary),
  tidied: report.tidied.map(redactSecrets),
  remembered: report.remembered.map(redactSecrets),
  asks: report.asks.map(redactSecrets),
  found: report.found.map(redactSecrets),
  nothing_to_do: report.nothing_to_do,
})

/** The tools the control room serves a dream: its report, stored redacted, the last one kept. */
export function dreamTools(store: (report: DreamReport) => Promise<void>): DreamTool[] {
  return [
    {
      server: DREAM_SERVER,
      name: DREAM_REPORT,
      description:
        'Report what this dream did, once at the end; a second call replaces the first. The report is the only thing the user reads.',
      input: dreamReport.shape,
      call: async (args) => {
        const parsed = dreamReport.safeParse(args)
        if (!parsed.success) {
          return `Not stored: ${describeIssues(parsed.error)}. Fix it and call again.`
        }
        await store(redacted(parsed.data))
        return 'Stored. Stop now unless something is left half done.'
      },
    },
  ]
}
