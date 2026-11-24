import { EA_SETTINGS_DEFAULT } from '@seti/shared'
import { describe, expect, it } from 'vitest'
import { transaction } from '../db.js'
import { archiveSettings } from './archive.js'
import { codexSettings } from './codex-settings.js'
import { compactSettings } from './compact.js'
import { cpuSettings } from './cpu.js'
import { eaSettings } from './ea.js'
import { mcpDefaults } from './mcp.js'
import { userSettings } from './user.js'

const { updated_at: _, ...ea } = EA_SETTINGS_DEFAULT

describe('settings setters in one transaction', () => {
  it('apply together or not at all', async () => {
    await userSettings.set({ name: 'Before' })
    const before = {
      ea: await eaSettings.get(),
      compact: await compactSettings.get(),
      cpu: await cpuSettings.get(),
      codex: await codexSettings.get(),
      archive: await archiveSettings.get(),
      mcp: await mcpDefaults.all(),
    }
    const failed = transaction(async (tx) => {
      await userSettings.set({ name: 'During' }, tx)
      expect((await eaSettings.save({ ...ea, wake_phrase: 'Hello there' }, tx)).wake_phrase).toBe('Hello there')
      await compactSettings.set({ auto: false, window_k: 200, threshold_pct: 50, instructions: null }, tx)
      await cpuSettings.set({ quota_percent: 150 }, tx)
      await codexSettings.set({ ...before.codex, default_effort: 'low' }, tx)
      await archiveSettings.set({ ...before.archive, days: 3 }, tx)
      await mcpDefaults.set('tx-server', false, true, tx)
      expect((await eaSettings.get()).wake_phrase).toBe(before.ea.wake_phrase)
      throw new Error('stop')
    })
    await expect(failed).rejects.toThrow('stop')
    expect((await userSettings.get())?.name).toBe('Before')
    expect(await eaSettings.get()).toEqual(before.ea)
    expect(await compactSettings.get()).toEqual(before.compact)
    expect(await cpuSettings.get()).toEqual(before.cpu)
    expect(await codexSettings.get()).toEqual(before.codex)
    expect(await archiveSettings.get()).toEqual(before.archive)
    expect(await mcpDefaults.all()).toEqual(before.mcp)
  })
})
