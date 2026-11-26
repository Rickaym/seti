/** A write gh makes to a repository's pull requests, issues or releases, as `group verb`. */
export type GhWrite =
  | 'pr comment'
  | 'pr review'
  | 'pr merge'
  | 'pr close'
  | 'pr reopen'
  | 'pr ready'
  | 'pr edit'
  | 'pr lock'
  | 'pr unlock'
  | 'pr update-branch'
  | 'pr revert'
  | 'issue create'
  | 'issue comment'
  | 'issue close'
  | 'issue reopen'
  | 'issue edit'
  | 'issue delete'
  | 'issue lock'
  | 'issue unlock'
  | 'issue pin'
  | 'issue unpin'
  | 'issue transfer'
  | 'issue develop'
  | 'release create'
  | 'release edit'
  | 'release delete'
  | 'release upload'
  | 'release delete-asset'

/** What a command sends to a code host: a push, a fork, a pull request, an API or gh write. */
export type OutwardAction = 'push' | 'fork' | 'pr' | 'api' | GhWrite

/**
 * Where it goes: a repository gh names, an owner, a URL or path git pushes to from a folder (its
 * rewrites apply), a remote of the folder's repository (null for git's default, '*' for every
 * remote gh may pick), or a place Seti cannot read.
 */
type OutwardWhere =
  | { repo: string }
  | { owner: string }
  | { url: string; dir: string }
  | { remote: string | null; dir: string }
  | { unknown: string }

export interface Outward {
  action: OutwardAction
  where: OutwardWhere
}

/** The index of the first word from `at` that is no option, skipping the values of `paired`. */
export function positional(words: readonly string[], at: number, paired: readonly string[]): number {
  let next = at
  while ((words[next] ?? '').startsWith('-')) {
    next += paired.includes(words[next] ?? '') ? 2 : 1
  }
  return next
}

/** The value of an option given as `--name value`, `--name=value` or `-x value`, or undefined. */
export function optionValue(words: readonly string[], names: readonly string[]): string | undefined {
  for (let at = 0; at < words.length; at += 1) {
    const word = words[at] ?? ''
    const joined = names.find((name) => name.startsWith('--') && word.startsWith(`${name}=`))
    if (joined !== undefined) {
      return word.slice(joined.length + 1)
    }
    if (names.includes(word)) {
      return words[at + 1]
    }
  }
  return undefined
}

/** A repository gh acts on by default: one of the folder's remotes, as gh picks among them. */
export const current = (action: OutwardAction, dir: string | null): Outward =>
  dir === null
    ? { action, where: { unknown: 'Seti cannot tell which repository it acts on' } }
    : { action, where: { remote: '*', dir } }

/** A repository as gh takes it (`OWNER/REPO`, `HOST/OWNER/REPO`, a URL), with its host as a URL. */
export const ghRepo = (given: string) => (/^[\w-]+(\.[\w-]+)+\/[^/]+\/[^/]+$/.test(given) ? `https://${given}` : given)
