import type { ThreadReach } from '@seti/shared'
import { describe, expect, it } from 'vitest'
import { taskArchives } from '../store/archive.js'
import { EA_AUTH } from '../test-auth.js'
import { agentSends, api, data, quietTask, slackWebhook } from './test-slack-kit.js'

const reach = async (auth?: Record<string, string>) =>
  data<ThreadReach>(await api('GET', '/channels/thread-reach', undefined, auth))

describe('GET /api/channels/thread-reach', () => {
  it('counts the threads live agents follow and the webhooks with thread replies on', async () => {
    expect(await reach()).toEqual({ following: 0, reading: 0 })

    const agent = await quietTask()
    await agentSends(agent, 'C0REACH0001', '1700000001.000100')
    await agentSends(agent, 'C0REACH0002', '1700000002.000100')
    expect(await reach()).toEqual({ following: 2, reading: 0 })

    const webhook = await slackWebhook('Slack replies')
    expect(await reach()).toEqual({ following: 2, reading: 0 })
    await data(await api('PUT', `/channels/${webhook.id}/threads`, { replies: true }))
    expect(await reach()).toEqual({ following: 2, reading: 1 })
    expect(await reach(EA_AUTH)).toEqual({ following: 2, reading: 1 })
  })

  it('leaves out stopped threads and the threads of archived agents', async () => {
    const before = (await reach()).following
    const stopped = await quietTask()
    await agentSends(stopped, 'C0REACH0003', '1700000003.000100')
    const [thread] = await data<{ id: number }[]>(await api('GET', `/tasks/${stopped}/threads`))
    await data(await api('POST', `/tasks/${stopped}/threads/${String(thread?.id)}/stop`))
    const archived = await quietTask()
    await agentSends(archived, 'C0REACH0004', '1700000004.000100')
    expect((await reach()).following).toBe(before + 1)
    await taskArchives.archive(archived, 'user')
    expect((await reach()).following).toBe(before)
  })
})
