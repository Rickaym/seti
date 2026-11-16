import { reviewCoverageSchema, type ReviewCoverage } from '@seti/shared'
import { apiGetValid } from '@/api'

/** What the server of a rule offers to review, in the scope whose rules live at `path`. */
export const loadCoverage = async (path: string, rule: string): Promise<ReviewCoverage> =>
  apiGetValid(`${path}/coverage?rule=${encodeURIComponent(rule)}`, reviewCoverageSchema)

/** Whether a checklist has anything to offer beyond the rule the user typed. */
export const hasSiblings = (coverage: ReviewCoverage): boolean =>
  coverage.tool !== null && coverage.tools.some((tool) => tool.rule !== coverage.tool && !tool.reviewed)

/** Where a checklist's tools come from, so the user knows how far to trust the list. */
export function basisLine(coverage: ReviewCoverage): string {
  const { label, tools } = coverage
  const unknown = tools.filter((tool) => tool.basis === 'unknown').length
  const known = String(tools.length - unknown)
  if (unknown === tools.length) {
    return `Seti cannot tell which ${label} tools write, so all are listed and none is selected.`
  }
  const source = tools.some((tool) => tool.basis === 'annotations')
    ? `${label} marks ${known} of its tools as not read-only.`
    : `${label} does not say which of its tools write, so Seti goes by their names.`
  return unknown === 0 ? source : `${source} Seti cannot place the ones marked Unknown, so they start unselected.`
}
