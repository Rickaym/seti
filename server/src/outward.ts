import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'

const WRITE_WORDS = new Set([
  'send',
  'create',
  'update',
  'delete',
  'post',
  'add',
  'remove',
  'merge',
  'share',
  'trash',
  'upload',
  'schedule',
  'submit',
  'approve',
  'reject',
  'move',
  'set',
  'trigger',
  'modify',
  'link',
  'unlink',
  'assign',
  'deactivate',
  'reactivate',
  'edit',
  'start',
  'stop',
  'rerun',
  'bulk',
  'generate',
  'complete',
  'execute',
  'run',
  'publish',
  'copy',
  'write',
  'upsert',
  'insert',
  'invite',
  'archive',
])
const READ_WORDS = new Set([
  'get',
  'list',
  'read',
  'search',
  'fetch',
  'query',
  'find',
  'download',
  'check',
  'describe',
  'resolve',
  'evaluate',
  'view',
  'lookup',
  'count',
  'retrieve',
  'show',
  'status',
  'docs',
])

const OUTWARD_BASH = [
  /\bgit\s+push\b/,
  /\bgh\s+(pr|issue|release|repo|label|workflow|run)\s+(create|merge|comment|close|reopen|edit|review|delete|ready|run|rerun|cancel)\b/,
  /\bgh\s+api\b.*(-X|--method)\s*(POST|PUT|PATCH|DELETE)\b/i,
  /\bkubectl\s+(apply|create|delete|patch|replace|scale|rollout|set|edit|annotate|label|cordon|drain)\b/,
  /\bhelm\s+(install|upgrade|uninstall|rollback)\b/,
  /\baws\s+\S+\s+(create|delete|put|update|run|start|stop|terminate|register|deregister)/,
  /\bcurl\b.*(-X|--request)\s*(POST|PUT|PATCH|DELETE)\b/i,
  /\b(npm|pnpm)\s+publish\b/,
  /\bdocker\s+push\b/,
  /\bssh\b/,
]

function words(s: string): string[] {
  return s
    .replace(/([a-z])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .split(/[_\-\s]+/)
    .filter(Boolean)
}

export function bashCommand(input: unknown): string {
  if (typeof input !== 'object' || input === null || !('command' in input)) {
    return ''
  }
  return typeof input.command === 'string' ? input.command : ''
}

/** Seti tools that change only the calling agent's own row in Seti. */
const OWN_ROW_TOOLS = new Set(['mcp__seti__set_status'])

/** True when a tool call can change something outside this machine. Unknown MCP tools count. */
export function isOutward(name: string, input: unknown): boolean {
  if (OWN_ROW_TOOLS.has(name)) {
    return false
  }
  if (name.startsWith('mcp__')) {
    const w = words(name.split('__').pop() ?? '')
    return w.some((x) => WRITE_WORDS.has(x)) || !w.some((x) => READ_WORDS.has(x))
  }
  if (name === 'Bash') {
    const cmd = bashCommand(input)
    return OUTWARD_BASH.some((re) => re.test(cmd))
  }
  return false
}

export function outwardToolUses(m: SDKMessage): string[] {
  if (m.type !== 'assistant') {
    return []
  }
  return m.message.content.flatMap((block) =>
    block.type === 'tool_use' && isOutward(block.name, block.input) ? [block.id] : [],
  )
}
