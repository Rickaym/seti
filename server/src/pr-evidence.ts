import { findPrUrls } from '@seti/shared'
import { z } from 'zod'
import type { PrHead } from './github.js'
import { bashCommand } from './outward.js'
import { createsPrCall } from './pr-link.js'
import type { StoredRow } from './store/pr-discovery.js'

/** A branch a task pushed; repo is owner/name when the push output names a GitHub remote. */
export interface Push {
  branch: string
  repo: string | null
}

/** What the task's own actions show: the PRs it opened or pushed to, and the branches it pushed. */
export interface PrEvidence {
  created: Set<string>
  pushedTo: Set<string>
  pushes: Push[]
}

const SEGMENT = /&&|\|\||[;|\n]/
const GIT_VALUE_OPTIONS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace'])
const PUSH_VALUE_OPTIONS = new Set(['-o', '--push-option', '--repo', '--receive-pack', '--exec'])
const PUSH_NOT_BRANCHES = new Set(['-d', '--delete', '--tags', '--mirror', '--prune'])
const REDIRECT = /^\d*[<>]/
const REDIRECT_ALONE = /^\d*[<>]+$/
const PREFIX_ARG = /^(?:\w+=|\d+[smhd]?$)/
const PREFIXES = new Set(['', 'env', 'command', 'exec', 'time', 'timeout', 'nice', 'sudo'])

const WRAPPERS = new Set(['(', ')', "'", '"'])

function unquote(token: string): string {
  let start = 0
  let end = token.length
  while (start < end && WRAPPERS.has(token.charAt(start))) {
    start += 1
  }
  while (end > start && WRAPPERS.has(token.charAt(end - 1))) {
    end -= 1
  }
  return token.slice(start, end)
}

/** Branch a refspec pushes to, or null when the output has to tell (HEAD, a variable). */
function refspecBranch(refspec: string): string | null {
  const spec = refspec.replace(/^\+/, '')
  const colon = spec.indexOf(':')
  const target = colon === -1 ? spec : spec.slice(colon + 1)
  const branch = target.replace(/^refs\/heads\//, '')
  if (branch === '' || branch === 'HEAD' || branch.startsWith('refs/') || branch.includes('$')) {
    return null
  }
  return branch
}

interface PushTargets {
  named: string[]
  /** The command pushes branches it does not name, so only its output can tell which. */
  unnamed: boolean
}

/** The arguments after `git push` in one shell segment; null when the segment runs no push. */
function pushArgs(segment: string): string[] | null {
  const tokens = segment.trim().split(/\s+/).map(unquote)
  const git = tokens.indexOf('git')
  if (git === -1 || !tokens.slice(0, git).every((token) => PREFIX_ARG.test(token) || PREFIXES.has(token))) {
    return null
  }
  let at = git + 1
  while (tokens[at]?.startsWith('-') === true) {
    at += GIT_VALUE_OPTIONS.has(tokens[at] ?? '') ? 2 : 1
  }
  return tokens[at] === 'push' ? tokens.slice(at + 1) : null
}

function segmentTargets(segment: string): PushTargets | null {
  const args = pushArgs(segment)
  if (args === null || args.some((arg) => PUSH_NOT_BRANCHES.has(arg))) {
    return null
  }
  const positional: string[] = []
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? ''
    if (PUSH_VALUE_OPTIONS.has(arg) || REDIRECT_ALONE.test(arg)) {
      index += 1
    } else if (!REDIRECT.test(arg) && !arg.startsWith('-') && arg !== '') {
      positional.push(arg)
    }
  }
  const branches = positional.slice(1).map(refspecBranch)
  const named = branches.filter((branch) => branch !== null)
  return { named, unnamed: branches.length === 0 || named.length < branches.length }
}

/** Branches a shell command pushes by name; null when it runs no git push. */
export function pushTargets(command: string): PushTargets | null {
  const found = command
    .split(SEGMENT)
    .map(segmentTargets)
    .filter((targets) => targets !== null)
  if (found.length === 0) {
    return null
  }
  return { named: found.flatMap((targets) => targets.named), unnamed: found.some((targets) => targets.unnamed) }
}

const TO_LINE = /^To\s+(\S+)/
const FROM_LINE = /^From\s/
const REF_LINE = /^ [ *+=!-] \S/
const ARROW = ' -> '
const GITHUB_REMOTE = /github\.com[:/]+([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/i
const PUSH_FAILED = /error: failed to push|^fatal:/m

interface PushOutput {
  pushed: Push[]
  rejected: Set<string>
  repo: string | null
  failed: boolean
}

/** The branch a ref line of git's push report updates, and whether the remote refused it. */
function refLine(line: string): { branch: string; rejected: boolean } | null {
  const arrow = line.indexOf(ARROW)
  if (!REF_LINE.test(line) || arrow === -1) {
    return null
  }
  const branch = (
    line
      .slice(arrow + ARROW.length)
      .trim()
      .split(' ')[0] ?? ''
  ).replace(/^refs\/heads\//, '')
  if (branch === '' || branch.startsWith('refs/')) {
    return null
  }
  return { branch, rejected: line.charAt(1) === '!' || line.includes('rejected]') }
}

/** The refs a git push printed as updated or rejected, and the GitHub repo it pushed to. */
export function pushOutput(text: string): PushOutput {
  const out: PushOutput = { pushed: [], rejected: new Set(), repo: null, failed: PUSH_FAILED.test(text) }
  let section: { repo: string | null } | null = null
  for (const line of text.split('\n')) {
    const to = TO_LINE.exec(line)
    if (to) {
      section = { repo: GITHUB_REMOTE.exec(to[1] ?? '')?.[1] ?? null }
      out.repo ??= section.repo
      continue
    }
    if (FROM_LINE.test(line)) {
      section = null
    }
    const ref = section === null ? null : refLine(line)
    if (ref?.rejected === true) {
      out.rejected.add(ref.branch)
    } else if (ref !== null && section !== null) {
      out.pushed.push({ branch: ref.branch, repo: section.repo })
    }
  }
  return out
}

/** Branches one git push call updated: those its output shows, and those it names unless refused. */
export function pushesOf(command: string, output: string): Push[] {
  const targets = pushTargets(command)
  if (targets === null) {
    return []
  }
  const out = pushOutput(output)
  const shown = new Set(out.pushed.map((push) => push.branch))
  const named = targets.named
    .filter((branch) => !shown.has(branch) && !out.rejected.has(branch) && !out.failed)
    .map((branch) => ({ branch, repo: out.repo }))
  return [...out.pushed, ...named]
}

/** Whether the task pushed the PR's head branch, to its repo when the push named one. */
export const pushedHead = (pr: PrHead, pushes: readonly Push[]): boolean =>
  pushes.some(
    (push) =>
      push.branch === pr.head_ref &&
      (push.repo === null || pr.head_repo === null || push.repo.toLowerCase() === pr.head_repo.toLowerCase()),
  )

const toolUse = z.object({ type: z.literal('tool_use'), id: z.string(), name: z.string(), input: z.unknown() })
const toolResult = z.object({
  type: z.literal('tool_result'),
  tool_use_id: z.string(),
  content: z.union([z.string(), z.array(z.object({ type: z.string(), text: z.string().optional() }))]).optional(),
})
const sdkRow = z.object({ message: z.object({ content: z.array(z.unknown()) }) })
/** Claude Code's own report that the session opened a PR or pushed to one. */
const published = z.object({
  type: z.literal('system'),
  subtype: z.literal('code_change_published'),
  url: z.string(),
  action: z.string(),
})

/** Content blocks of a message row, or the row itself when it reports a published change. */
function blocksOf(payload: string): unknown[] {
  try {
    const value: unknown = JSON.parse(payload)
    const parsed = sdkRow.safeParse(value)
    return parsed.success ? parsed.data.message.content : [value]
  } catch {
    return []
  }
}

function textOf(content: z.infer<typeof toolResult>['content']): string {
  if (typeof content === 'string') {
    return content
  }
  return (content ?? []).map((part) => part.text ?? '').join('\n')
}

function record(evidence: PrEvidence, call: z.infer<typeof toolUse>, text: string): void {
  if (createsPrCall(call.name, call.input)) {
    findPrUrls(text).forEach((url) => evidence.created.add(url))
  }
  if (call.name === 'Bash') {
    evidence.pushes.push(...pushesOf(bashCommand(call.input), text))
  }
}

function recordPublished(evidence: PrEvidence, change: z.infer<typeof published>): void {
  findPrUrls(change.url).forEach((url) => {
    if (change.action === 'created') {
      evidence.created.add(url)
    } else if (change.action === 'pushed') {
      evidence.pushedTo.add(url)
    }
  })
}

/** PRs the task opened or pushed to and branches it pushed, pairing each call with its result. */
export function transcriptEvidence(rows: readonly StoredRow[]): PrEvidence {
  const calls = new Map<string, z.infer<typeof toolUse>>()
  const evidence: PrEvidence = { created: new Set(), pushedTo: new Set(), pushes: [] }
  const blocks = rows.flatMap((row) => (row.kind === 'sdk' ? blocksOf(row.payload) : []))
  for (const block of blocks) {
    const use = toolUse.safeParse(block)
    const result = toolResult.safeParse(block)
    const change = published.safeParse(block)
    if (use.success) {
      calls.set(use.data.id, use.data)
    } else if (result.success) {
      const call = calls.get(result.data.tool_use_id)
      if (call !== undefined) {
        record(evidence, call, textOf(result.data.content))
      }
    } else if (change.success) {
      recordPublished(evidence, change.data)
    }
  }
  return evidence
}
