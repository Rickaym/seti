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
