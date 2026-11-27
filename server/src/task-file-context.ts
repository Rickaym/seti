import { sandboxContext } from './session-options.js'
import { sandboxPolicy } from './store/sandbox.js'
import { fileRules, taskRoots, type FileContext } from './task-files.js'
import { requireTask } from './tasks.js'

/** An agent's file roots under the sandbox's rules, for the Files panel and seti tools. */
export async function taskFileContext(id: string): Promise<FileContext> {
  const task = await requireTask(id)
  const rules = fileRules(task.id, await sandboxPolicy.get(), sandboxContext())
  return { task, rules, roots: taskRoots(task, rules) }
}
