import type { StagedUpload } from '@seti/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  attachmentStore,
  outgoing,
  pasteAttachment,
  uniqueName,
  withInline,
  withoutToken,
  withTokens,
  type DraftAttachment,
} from '@/lib/attachments'

const staged = (id: string): StagedUpload => ({
  id,
  name: 'paste.json',
  source: 'paste',
  kind: 'text',
  type: 'JSON',
  mime: 'application/json',
  size: 10,
  lines: 1,
  shown: false,
})

const item = (token: string, id: string | null): DraftAttachment => ({
  key: token,
  token,
  name: token.slice(1, -1),
  kind: 'text',
  type: 'JSON',
  size: 10,
  lines: 1,
  staged: id === null ? null : staged(id),
  text: '{"a":1}',
})

describe('pasted text', () => {
  it('names pastes paste-N by their detected type, counting past earlier ones', () => {
    const first = pasteAttachment('{"a": [1, 2]}', [])
    expect(first).toMatchObject({ name: 'paste-1.json', token: '[paste-1.json]', type: 'JSON', lines: 1 })
    const second = pasteAttachment('plain words', ['paste-1.json', 'shot.png'])
    expect(second.name).toBe('paste-2.txt')
  })

  it('keeps file names apart within a draft', () => {
    expect(uniqueName('shot.png', [])).toBe('shot.png')
    expect(uniqueName('shot.png', ['shot.png', 'shot-2.png'])).toBe('shot-3.png')
    expect(uniqueName('Makefile', ['Makefile'])).toBe('Makefile-2')
  })
})

describe('the outgoing message', () => {
  it('sends uploaded files by their tokens and puts lost tokens back at the end', () => {
    const items = [item('[a.json]', 'id-a'), item('[b.json]', 'id-b'), item('[c.json]', null)]
    expect(outgoing('Read [a.json] first', items)).toEqual({
      prompt: 'Read [a.json] first\n\n[b.json]',
      attachments: [
        { id: 'id-a', token: '[a.json]' },
        { id: 'id-b', token: '[b.json]' },
      ],
    })
    expect(outgoing('', [item('[a.json]', 'id-a')]).prompt).toBe('[a.json]')
    expect(outgoing('Plain text ', [item('[c.json]', null)])).toEqual({ prompt: 'Plain text ' })
  })

  it('drops, inlines and appends tokens in the draft text', () => {
    expect(withoutToken('Read [a.json] now', '[a.json]')).toBe('Read now')
    expect(withoutToken('Read it', '[a.json]')).toBe('Read it')
    expect(withoutToken('[a.json] ', '[a.json]')).toBe('')
    expect(withInline('Read [a.json] now', '[a.json]', 'TEXT')).toBe('Read TEXT now')
    expect(withInline('Read', '[a.json]', 'TEXT')).toBe('Read\nTEXT')
    expect(withTokens('Look ', ['[a.png]', '[b.pdf]'])).toBe('Look [a.png] [b.pdf]')
    expect(withTokens('', ['[a.png]'])).toBe('[a.png]')
  })
})

describe('attachmentStore', () => {
  let saved: Map<string, string>

  beforeEach(() => {
    saved = new Map()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => saved.get(key) ?? null,
      setItem: (key: string, value: string) => saved.set(key, value),
      removeItem: (key: string) => saved.delete(key),
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('keeps uploaded files with the draft, without their text, and forgets the rest', () => {
    attachmentStore.write('task.1', [item('[a.json]', 'id-a'), item('[b.json]', null)])
    const restored = attachmentStore.read('task.1')
    expect(restored.map((file) => file.token)).toEqual(['[a.json]'])
    expect(restored[0]?.text).toBeUndefined()
    attachmentStore.write('task.1', [])
    expect(saved.size).toBe(0)
  })
})
