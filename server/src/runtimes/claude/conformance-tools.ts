import type { ScriptCall } from '../conformance/script.js'

type Args = Record<string, unknown>

/** The script's questions as AskUserQuestion takes them. */
const claudeQuestions = (questions: unknown) =>
  (Array.isArray(questions) ? (questions as { text: string; options: string[] }[]) : []).map((q) => ({
    question: q.text,
    header: 'Question',
    options: q.options.map((label) => ({ label, description: '' })),
    multiSelect: false,
  }))

/** The script's plan items as TodoWrite takes them. */
const claudeTodos = (items: unknown) =>
  (Array.isArray(items) ? (items as { text: string; status: string }[]) : []).map((item) => ({
    content: item.text,
    status: item.status,
    activeForm: item.text,
  }))

/** What Claude Code tells the model once the user answered its questions. */
export const answered = (input: Args | undefined): string =>
  `User has answered your questions: ${Object.entries((input?.answers ?? {}) as Record<string, string>)
    .map(([question, answer]) => `"${question}"="${answer}"`)
    .join(', ')}`

/** The script's tools as Claude Code names them, with Claude Code's input for the same call. */
const TOOLS = new Map<string, (args: Args) => [string, Args]>([
  [
    'sh',
    (args) => [
      'Bash',
      { command: args.cmd, description: 'Run it', ...(args.background === true ? { run_in_background: true } : {}) },
    ],
  ],
  ['cat', (args) => ['Read', { file_path: args.path }]],
  ['patch', (args) => ['Edit', { file_path: args.path, old_string: 'a', new_string: 'b' }]],
  ['grep', (args) => ['Grep', { pattern: args.pattern }]],
  ['fetch', (args) => ['WebFetch', { url: args.url, prompt: 'Read it' }]],
  ['ask', (args) => ['AskUserQuestion', { questions: claudeQuestions(args.questions) }]],
  ['todo', (args) => ['TodoWrite', { todos: claudeTodos(args.items) }]],
])

export const claudeTool = (call: ScriptCall): [string, Args] => {
  const mcp = /^([\w-]+)\.([\w-]+)$/.exec(call.tool)
  if (mcp !== null) {
    return [`mcp__${mcp[1] ?? ''}__${mcp[2] ?? ''}`, call.args]
  }
  return TOOLS.get(call.tool)?.(call.args) ?? [call.tool, call.args]
}

/** Tools Claude Code asks about in its default mode when no rule allows them. */
export const isGated = (name: string) =>
  ['Bash', 'Edit', 'Write', 'WebFetch', 'AskUserQuestion'].includes(name) || name.startsWith('mcp__')
