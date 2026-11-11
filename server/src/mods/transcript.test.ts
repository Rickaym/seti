import { modManifest, type Disposer, type TaskEvent } from '@seti/shared'
import { describe, expect, it } from 'vitest'
import { tasks } from '../db.js'
import { subscribe } from '../task-events.js'
import { transcriptApi } from './transcript.js'

const manifest = (blocks: boolean) =>
  modManifest.parse({
    id: 'notes',
    name: 'Notes',
    version: '1.0.0',
    seti: '^1.21',
    description: 'Notes in the transcript',
    contributes: blocks ? { transcriptBlocks: [{ id: 'notes', title: 'Notes' }] } : {},
  })

describe('the transcript blocks API', () => {
  it("tells an agent's transcript stream which mod's blocks changed, until the mod is off", async () => {
    await tasks.insert({ id: 'blocks-1', title: 'Blocks', repo_id: null, cwd: '/tmp', worktree: false, pr_urls: [] })
    const seen: TaskEvent[] = []
    const stop = subscribe('blocks-1', (event) => {
      seen.push(event)
    })
    const disposers: Disposer[] = []
    const api = transcriptApi(manifest(true), (dispose) => {
      disposers.push(dispose)
      return dispose
    })
    await api.refresh('blocks-1')
    await api.refresh('no-such-agent')
    for (const dispose of disposers) {
      dispose()
    }
    await api.refresh('blocks-1')
    stop()
    expect(seen).toEqual([{ type: 'blocks', mod: 'notes' }])
  })

  it('refuses a mod whose manifest declares no transcript blocks', async () => {
    const api = transcriptApi(manifest(false), (dispose) => dispose)
    await expect(api.refresh('blocks-1')).rejects.toThrow('does not declare')
  })
})
