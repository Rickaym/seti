import type { LinkedTask, PrRelation, RelatedPr } from '@seti/shared'
import type { OpenPr } from './github.js'
import { refKey } from './pr-refs.js'

type Target = Omit<RelatedPr, 'reasons'>
type AddEdge = (from: string, to: Target, reason: PrRelation) => void

/** Larger groups on one branch or task are noise such as bot branches; they add no edges. */
const MAX_GROUP = 20
const LONG_LIVED = new Set(['main', 'master', 'dev', 'develop', 'development', 'staging', 'prod', 'production'])
const WEB_EDITOR_BRANCH = /^patch-\d+$/
const PR_PARTS = /github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/

const repoName = (slug: string) => slug.split('/').at(-1) ?? slug

const openTarget = (pr: OpenPr): Target => ({
  url: pr.url,
  key: pr.key,
  label: `${repoName(pr.repo_slug)}#${String(pr.number)}`,
  title: pr.title,
  ci: pr.ci,
})

const outsideTarget = (slug: string, number: number): Target => ({
  url: `https://github.com/${slug}/pull/${String(number)}`,
  key: null,
  label: `${slug}#${String(number)}`,
  title: null,
  ci: null,
})

function urlTarget(url: string, byUrl: ReadonlyMap<string, OpenPr>): Target {
  const pr = byUrl.get(url)
  if (pr) {
    return openTarget(pr)
  }
  const [, slug, number] = PR_PARTS.exec(url) ?? []
  return slug === undefined || number === undefined
    ? { url, key: null, label: url, title: null, ci: null }
    : outsideTarget(slug, Number(number))
}

function groupBy<T>(items: readonly T[], keyOf: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>()
  for (const item of items) {
    const key = keyOf(item)
    groups.set(key, [...(groups.get(key) ?? []), item])
  }
  return groups
}

const sameReason = (a: PrRelation, b: PrRelation) => JSON.stringify(a) === JSON.stringify(b)

function relateMentions(prs: readonly OpenPr[], add: AddEdge): void {
  const byRef = new Map(prs.map((pr) => [refKey(pr.repo_slug, pr.number), pr]))
  for (const pr of prs) {
    for (const ref of pr.refs) {
      const target = byRef.get(refKey(ref.slug, ref.number))
      if (target) {
        add(pr.url, openTarget(target), { type: 'mentions', place: ref.place })
        add(target.url, openTarget(pr), { type: 'mentioned_by', place: ref.place })
      } else if (ref.pull) {
        add(pr.url, outsideTarget(ref.slug, ref.number), { type: 'mentions', place: ref.place })
      }
    }
  }
}

function urlsByTask(tasksByUrl: ReadonlyMap<string, readonly LinkedTask[]>): Map<string, [LinkedTask, string[]]> {
  const byTask = new Map<string, [LinkedTask, string[]]>()
  for (const [url, tasks] of tasksByUrl) {
    for (const task of tasks) {
      const entry = byTask.get(task.id) ?? [task, []]
      entry[1].push(url)
      byTask.set(task.id, entry)
    }
  }
  return byTask
}

function relateTasks(
  byUrl: ReadonlyMap<string, OpenPr>,
  tasksByUrl: ReadonlyMap<string, readonly LinkedTask[]>,
  add: AddEdge,
): void {
  for (const [task, urls] of urlsByTask(tasksByUrl).values()) {
    if (urls.length < 2 || urls.length > MAX_GROUP) {
      continue
    }
    const reason: PrRelation = { type: 'same_task', task_id: task.id, task_title: task.title }
    for (const from of urls.filter((url) => byUrl.has(url))) {
      for (const to of urls.filter((url) => url !== from)) {
        add(from, urlTarget(to, byUrl), reason)
      }
    }
  }
}

/** A base only one stacked PR builds on is a feature branch; other bases are long-lived. */
function longLivedBranches(prs: readonly OpenPr[], repoBases: readonly string[]): Set<string> {
  const heads = new Set(prs.map((pr) => pr.head_ref))
  const byBase = groupBy(prs, (pr) => pr.base_ref)
  const bases = [...byBase].filter(([base, children]) => !heads.has(base) || children.length > 1).map(([b]) => b)
  return new Set([...LONG_LIVED, ...repoBases, ...bases])
}

function relateBranches(prs: readonly OpenPr[], repoBases: readonly string[], add: AddEdge): void {
  const longLived = longLivedBranches(prs, repoBases)
  const byBranch = groupBy(prs, (pr) => pr.head_ref)
  for (const [branch, members] of byBranch) {
    if (members.length < 2 || members.length > MAX_GROUP || longLived.has(branch) || WEB_EDITOR_BRANCH.test(branch)) {
      continue
    }
    for (const from of members) {
      for (const to of members.filter((pr) => pr !== from)) {
        add(from.url, openTarget(to), { type: 'same_branch', branch })
      }
    }
  }
}

function byOpenThenLabel(a: RelatedPr, b: RelatedPr): number {
  const open = Number(a.key === null) - Number(b.key === null)
  return open === 0 ? a.label.localeCompare(b.label) : open
}

/** Related PRs per open PR URL, by mention, shared Seti task or shared feature branch. */
export function relatePrs(
  prs: readonly OpenPr[],
  tasksByUrl: ReadonlyMap<string, readonly LinkedTask[]>,
  repoBases: readonly string[] = [],
): Map<string, RelatedPr[]> {
  const edges = new Map<string, Map<string, RelatedPr>>()
  const add: AddEdge = (from, to, reason) => {
    const out = edges.get(from) ?? new Map<string, RelatedPr>()
    edges.set(from, out)
    const entry = out.get(to.url) ?? { ...to, reasons: [] }
    out.set(to.url, entry)
    if (!entry.reasons.some((known) => sameReason(known, reason))) {
      entry.reasons.push(reason)
    }
  }
  relateMentions(prs, add)
  relateTasks(new Map(prs.map((pr) => [pr.url, pr])), tasksByUrl, add)
  relateBranches(prs, repoBases, add)
  return new Map([...edges].map(([url, out]) => [url, [...out.values()].sort(byOpenThenLabel)]))
}
