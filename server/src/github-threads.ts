import { z } from 'zod'

/** Review threads the PR list query reads, the first 100; outdated ones count while unresolved. */
export const THREAD_FIELDS = 'reviewThreads(first: 100) { nodes { isResolved } }'

export const reviewThreads = z.object({ nodes: z.array(z.object({ isResolved: z.boolean() })) })

export const unresolvedThreads = (threads: z.infer<typeof reviewThreads>): number =>
  threads.nodes.filter((thread) => !thread.isResolved).length
