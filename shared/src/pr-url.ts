import { z } from 'zod'

const PR_URL = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/

/** Every distinct GitHub pull request URL in a piece of text, in order of first appearance. */
export const findPrUrls = (text: string): string[] => [
  ...new Set(Array.from(text.matchAll(new RegExp(PR_URL.source, 'g')), (m) => m[0])),
]

export const prUrl = z.string().regex(new RegExp(`^${PR_URL.source}$`), 'must be a GitHub pull request URL')
