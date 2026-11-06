import { beforeAll, describe, expect, it } from 'vitest'
import { tasks } from './db.js'
import { setiPlugins, taskPluginChoices } from './store/plugins.js'

beforeAll(async () => {
  await tasks.insert({ id: 'old-task', title: 'Old task', repo_id: null, cwd: '/tmp', worktree: false, pr_urls: [] })
})

describe('plugin store', () => {
  it('starts without plugins or opt-outs', async () => {
    expect(await taskPluginChoices.get('old-task')).toEqual({})
    expect(await setiPlugins.list()).toEqual([])
  })

  it('keeps saved plugins and the opt-outs of tasks', async () => {
    const plugin = await setiPlugins.create({ name: 'kept', path: '/plugins/kept', version: '1', description: '' })
    await taskPluginChoices.setOptOuts('old-task', [plugin.id])
    expect(await setiPlugins.get(plugin.id)).toMatchObject({ name: 'kept', enabled: true })
    expect(await taskPluginChoices.get('old-task')).toEqual({ [plugin.id]: false })
  })

  it('drops opt-outs with their task or plugin', async () => {
    const plugin = await setiPlugins.create({
      name: 'dropped',
      path: '/plugins/dropped',
      version: null,
      description: '',
    })
    await tasks.insert({ id: 'temp', title: 'Temp', repo_id: null, cwd: '/tmp', worktree: false, pr_urls: [] })
    await taskPluginChoices.setOptOuts('temp', [plugin.id])
    await tasks.remove('temp')
    expect(await taskPluginChoices.get('temp')).toEqual({})

    await taskPluginChoices.setOptOuts('old-task', [plugin.id])
    await setiPlugins.remove(plugin.id)
    expect(await taskPluginChoices.get('old-task')).toEqual({})
  })
})
