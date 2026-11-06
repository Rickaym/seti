import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { drafts, MAX_DRAFT_CHARS, NEW_TASK_PROMPT, taskDraftKey } from '@/lib/drafts'

class MemoryStorage {
  readonly items = new Map<string, string>()
  getItem(key: string): string | null {
    return this.items.get(key) ?? null
  }
  setItem(key: string, value: string): void {
    this.items.set(key, value)
  }
  removeItem(key: string): void {
    this.items.delete(key)
  }
}

let storage: MemoryStorage

beforeEach(() => {
  storage = new MemoryStorage()
  vi.stubGlobal('localStorage', storage)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('drafts', () => {
  it('saves and restores a draft per key', () => {
    drafts.write(taskDraftKey('a'), 'half a reply')
    drafts.write(NEW_TASK_PROMPT, 'a new task')
    expect(drafts.read(taskDraftKey('a'))).toBe('half a reply')
    expect(drafts.read(taskDraftKey('b'))).toBe('')
    expect(drafts.read(NEW_TASK_PROMPT)).toBe('a new task')
    expect([...storage.items.keys()]).toEqual(['seti.draft.task.a', 'seti.draft.new-task.prompt'])
  })

  it('clears a draft with empty or blank text', () => {
    drafts.write(taskDraftKey('a'), 'text')
    drafts.write(taskDraftKey('a'), '')
    expect(drafts.read(taskDraftKey('a'))).toBe('')
    drafts.write(taskDraftKey('a'), '  \n ')
    expect(storage.items.size).toBe(0)
  })

  it('cuts a draft to the size cap', () => {
    drafts.write(taskDraftKey('a'), 'x'.repeat(MAX_DRAFT_CHARS + 50))
    expect(drafts.read(taskDraftKey('a'))).toHaveLength(MAX_DRAFT_CHARS)
  })

  it('loses only the draft when storage throws', () => {
    const blocked = (): never => {
      throw new DOMException('blocked', 'SecurityError')
    }
    vi.stubGlobal('localStorage', { getItem: blocked, setItem: blocked, removeItem: blocked })
    expect(() => {
      drafts.write(taskDraftKey('a'), 'text')
      drafts.write(taskDraftKey('a'), '')
    }).not.toThrow()
    expect(drafts.read(taskDraftKey('a'))).toBe('')
  })
})
