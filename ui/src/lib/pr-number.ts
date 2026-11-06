const PR_PARTS = /github\.com\/([\w.-]+\/([\w.-]+))\/pull\/(\d+)$/

/** `#123` for a PR of `homeSlug`, `repo#123` for a PR of another repo, the URL for anything else. */
export function prShortLabel(url: string, homeSlug: string | null): string {
  const [, slug, repo, number] = PR_PARTS.exec(url) ?? []
  if (slug === undefined || repo === undefined || number === undefined) {
    return url
  }
  return slug.toLowerCase() === homeSlug?.toLowerCase() ? `#${number}` : `${repo}#${number}`
}
