import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { describeIssues } from './http.js'

describe('describeIssues', () => {
  it('lists each issue with its path in plain ASCII', () => {
    const schema = z.object({ title: z.string().min(1, 'title is required'), repo_id: z.uuid() })
    const result = schema.safeParse({ title: '', repo_id: 'nope' })
    expect(result.success).toBe(false)
    const text = result.success ? '' : describeIssues(result.error)
    expect(text).toBe('title: title is required; repo_id: Invalid UUID')
    expect(text).toMatch(/^[\x20-\x7E]*$/)
  })

  it('leaves root-level issues without a path prefix', () => {
    const result = z.string().safeParse(1)
    expect(result.success ? '' : describeIssues(result.error)).toBe('Invalid input: expected string, received number')
  })
})
