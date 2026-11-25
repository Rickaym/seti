import { dreamProposalInput, dreamReport, type DreamProposalInput, type DreamReport } from '@seti/shared'
import { describeIssues } from '../http.js'
import type { DreamTool } from '../runtimes/adapter.js'
import { redactSecrets } from '../scrub.js'
import { DREAM_PROPOSE, DREAM_REPORT, DREAM_SERVER } from './gate.js'

const redacted = (report: DreamReport): DreamReport => ({
  summary: redactSecrets(report.summary),
  tidied: report.tidied.map(redactSecrets),
  remembered: report.remembered.map(redactSecrets),
  asks: report.asks.map(redactSecrets),
  found: report.found.map(redactSecrets),
  nothing_to_do: report.nothing_to_do,
  ...(report.config === undefined
    ? {}
    : { config: report.config.map((decision) => ({ ...decision, reason: redactSecrets(decision.reason) })) }),
})

/** The clean-up proposal tool: checked by the control room, applied only on the user's Allow. */
function proposeTool(propose: (input: DreamProposalInput) => Promise<string>): DreamTool {
  return {
    server: DREAM_SERVER,
    name: DREAM_PROPOSE,
    description:
      'Propose one clean-up for the user to allow in the morning: trash a file or folder, remove a worktree, or delete a merged branch. Nothing changes until they allow it; the control room checks it now and again then.',
    input: dreamProposalInput.shape,
    call: async (args) => {
      const parsed = dreamProposalInput.safeParse(args)
      return parsed.success ? propose(parsed.data) : `Not filed: ${describeIssues(parsed.error)}.`
    },
  }
}

/**
 * The tools the control room serves a dream: its report, stored redacted, the last one kept;
 * and, when the user turned clean-ups on, the proposal tool.
 */
export function dreamTools(
  store: (report: DreamReport) => Promise<void>,
  propose: ((input: DreamProposalInput) => Promise<string>) | null = null,
): DreamTool[] {
  return [
    ...(propose === null ? [] : [proposeTool(propose)]),
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
