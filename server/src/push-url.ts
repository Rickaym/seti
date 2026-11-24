/** One `url.<base>.insteadOf` or `pushInsteadOf` setting: what it rewrites and to what. */
interface Rewrite {
  push: boolean
  prefix: string
  base: string
}

/** The rewrites in `git config --get-regexp '^url\.'` output. */
function rewrites(listed: string): Rewrite[] {
  return listed.split('\n').flatMap((line) => {
    const space = line.indexOf(' ')
    const key = space < 0 ? line : line.slice(0, space)
    const match = /^url\.(.+)\.(pushinsteadof|insteadof)$/i.exec(key)
    if (match === null || space < 0) {
      return []
    }
    return [{ push: match[2]?.toLowerCase() === 'pushinsteadof', prefix: line.slice(space + 1), base: match[1] ?? '' }]
  })
}

/** The longest rewrite of one kind whose prefix starts the URL, or undefined. */
function longest(url: string, all: readonly Rewrite[], push: boolean): Rewrite | undefined {
  return all
    .filter((one) => one.push === push && one.prefix !== '' && url.startsWith(one.prefix))
    .reduce<Rewrite | undefined>(
      (best, one) => (best === undefined || one.prefix.length > best.prefix.length ? one : best),
      undefined,
    )
}

/**
 * Where git pushes a URL given on its command line: the longest `pushInsteadOf` match, else the
 * longest `insteadOf` match, else the URL itself.
 */
export function rewriteUrl(url: string, listed: string): string {
  const all = rewrites(listed)
  const chosen = longest(url, all, true) ?? longest(url, all, false)
  return chosen === undefined ? url : chosen.base + url.slice(chosen.prefix.length)
}
