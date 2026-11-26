import { COMMAND_SETTINGS, type Task } from '@seti/shared'
import { describe, expect, it, vi } from 'vitest'
import { COMMAND_BINDINGS } from './bindings'
import { choice, matchChoice } from './choices'
import { typedHere } from './typed-here'
import type { CommandContext } from './types'

const api = vi.hoisted(() => ({ calls: [] as string[] }))

vi.mock('@/api', async (importOriginal) => {
  const record = async (path: string) => {
    api.calls.push(path)
    return Promise.resolve({})
  }
  return {
    ...(await importOriginal<Record<string, unknown>>()),
    apiGet: record,
    apiPost: record,
    apiPut: record,
    apiPatch: record,
  }
})

const task = { id: 't1', title: 'Agent', sandbox: true, bypass_until: null, profile_id: 'default' } as unknown as Task

const context = (busy = false): CommandContext => ({
  task,
  running: false,
  busy,
  onChanged: () => undefined,
  openSettings: () => undefined,
  startRename: () => undefined,
  caps: null,
  sandboxOn: true,
  switchCredential: () => undefined,
})

async function stepFor(id: string, args: string, busy = false) {
  const bind = COMMAND_BINDINGS.get(id)
  if (bind === undefined) {
    throw new Error(`no binding for ${id}`)
  }
  return (await bind(context(busy)))(args)
}

describe('setting command bindings', () => {
  it('bind every setting command of the registry and nothing else', () => {
    const byName = (a: string, b: string) => a.localeCompare(b)
    expect([...COMMAND_BINDINGS.keys()].toSorted(byName)).toEqual(
      COMMAND_SETTINGS.map((entry) => entry.id).toSorted(byName),
    )
  })

  it('ask before archiving and refuse while the agent works, calling nothing until confirmed', async () => {
    api.calls.length = 0
    expect(await stepFor('archive', '')).toMatchObject({ kind: 'confirm', question: { confirmLabel: 'Archive' } })
    expect(await stepFor('archive', '', true)).toEqual({ kind: 'refuse', reason: 'Stop the agent to archive it' })
    expect(await stepFor('restart', '')).toMatchObject({ kind: 'confirm', question: { title: 'Restart session' } })
    expect(await stepFor('sandbox', 'off')).toMatchObject({ kind: 'confirm', question: { variant: 'destructive' } })
    expect(await stepFor('bypass', '8')).toMatchObject({ kind: 'confirm', question: { title: 'Turn Bypass on' } })
    expect(api.calls).toEqual([])
  })

  it('offer choices for a bare command that needs a value, with the current one marked', async () => {
    const step = await stepFor('sandbox', '')
    expect(step).toMatchObject({ kind: 'choose', choices: [{ label: 'On', current: true }, { label: 'Off' }] })
    expect(await stepFor('sandbox', 'on')).toEqual({ kind: 'refuse', reason: 'The sandbox is already on' })
    expect(await stepFor('settings', 'acc')).toMatchObject({ kind: 'run' })
  })
})

describe('what runs a setting command', () => {
  it('runs only a line typed or picked here with a real key or tap', () => {
    expect(typedHere(true, '/archive', '/archive')).toBe(true)
    expect(typedHere(true, null, '/archive')).toBe(false)
    expect(typedHere(true, '/archiv', '/archive')).toBe(false)
    expect(typedHere(false, '/archive', '/archive')).toBe(false)
  })

  it('takes a choice by its exact word or the only one a prefix names', () => {
    const items = [choice('on', 'On'), choice('off', 'Off'), choice('default', 'Default')]
    expect(matchChoice(items, 'OFF')?.args).toBe('off')
    expect(matchChoice(items, 'd')?.args).toBe('default')
    expect(matchChoice(items, 'o')).toBeNull()
    expect(matchChoice(items, '')).toBeNull()
  })
})
