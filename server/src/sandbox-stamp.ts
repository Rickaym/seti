import type { Task } from '@seti/shared'
import { taskSsh } from './agent-access.js'
import { taskAws } from './aws-access.js'
import { mcpTargets } from './sandbox-mcp.js'
import { keyStamp, sshStamp } from './ssh-files.js'
import { profiles } from './store/credentials.js'
import { sandboxPolicy } from './store/sandbox.js'
import { profileStamp } from './task-credentials.js'

/** The ssh hosts a task can use, with the hosts, keys and host keys its files render. */
async function sshSetup(taskId: string) {
  const reach = await taskSsh(taskId)
  return reach.usable.length === 0
    ? null
    : {
        hosts: reach.usable,
        rendered: reach.hosts,
        keys: await keyStamp(reach.hosts),
        known: await sshStamp(reach.knownHosts),
      }
}

/** What a task's sandbox is made of; a process in it needs a new sandbox when this changes. */
export const sandboxStamp = async (task: Task) => ({
  ...(await sandboxPolicy.get()),
  updated_at: null,
  task: task.sandbox,
  home: task.home_access,
  profile: await profileStamp(task),
  mcp: mcpTargets(),
  aws: (await taskAws(task.id)) ? ((await profiles.get(task.profile_id))?.aws.region ?? null) : null,
  ssh: await sshSetup(task.id),
})
