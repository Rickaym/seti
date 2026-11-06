import { z } from 'zod'

export type DigestKind = 'user' | 'agent' | 'tool' | 'subtask' | 'update' | 'shell' | 'status'

const DIGEST_LIMIT_MAX = 200

export const taskDigestQuery = z.object({
  limit: z.coerce.number().int().min(1).max(DIGEST_LIMIT_MAX).default(30),
})

export interface DigestLine {
  at: string
  kind: DigestKind
  text: string
}

export interface TaskDigest {
  lines: DigestLine[]
}
