import { z } from 'zod'

export const repoInput = z.object({
  slug: z.string().regex(/^[\w.-]+\/[\w.-]+$/, 'slug must look like owner/name'),
  path: z.string().min(1, 'path is required'),
  base_branch: z.string().min(1, 'base_branch is required'),
})
export type RepoInput = z.infer<typeof repoInput>

export interface Repo extends RepoInput {
  id: string
  created_at: string
}

export type RepoRef = Pick<Repo, 'id' | 'slug'>

const MAX_REPOS = 10

/** Ordered repos, the agent runs in the first; `repo_id` is shorthand for a one-repo list. */
export const repoSelectionFields = {
  repo_ids: z
    .array(z.uuid())
    .max(MAX_REPOS, `pick at most ${String(MAX_REPOS)} repos`)
    .refine((ids) => new Set(ids).size === ids.length, 'a repo can only be picked once')
    .default([]),
  repo_id: z.uuid().optional(),
}

interface RepoSelection {
  repo_ids: string[]
  repo_id?: string | undefined
}

export function checkRepoSelection(value: RepoSelection, ctx: z.RefinementCtx): void {
  if (value.repo_id !== undefined && value.repo_ids.length > 0) {
    ctx.addIssue({ code: 'custom', path: ['repo_id'], message: 'send repo_ids or repo_id, not both' })
  }
}

export const withRepoIds = <T extends RepoSelection>({ repo_id, ...rest }: T) => ({
  ...rest,
  repo_ids: repo_id === undefined ? rest.repo_ids : [repo_id],
})
