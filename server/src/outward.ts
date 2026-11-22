import type { RuntimeEvent, ToolCall } from '@seti/shared'
import { sharedToolWrites } from './shared-tool-writes.js'

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

/** The command line a call runs in a shell, or '' for any other call. */
export const shellCommand = (call: ToolCall): string => (call.shell?.action === 'run' ? (call.shell.command ?? '') : '')

/** Seti tools that change only the calling agent's own row in Seti. */
const OWN_ROW_TOOLS = new Set(['set_status', 'set_working_directory'])

/** What the words of an MCP tool's name say it does; a write word beats a read word. */
export function mcpNameKind(name: string): 'write' | 'read' | 'unknown' {
  const w = words(name.split('__').pop() ?? '')
  if (w.some((x) => WRITE_WORDS.has(x))) {
    return 'write'
  }
  return w.some((x) => READ_WORDS.has(x)) ? 'read' : 'unknown'
}

/** True when a tool call can change something outside this machine. Unknown MCP tools count. */
export function isOutward(call: ToolCall): boolean {
  if (call.mcp !== undefined) {
    if (call.mcp.server === 'seti' && OWN_ROW_TOOLS.has(call.mcp.tool)) {
      return false
    }
    return sharedToolWrites(call.name) ?? mcpNameKind(call.mcp.tool) !== 'read'
  }
  const command = shellCommand(call)
  return OUTWARD_BASH.some((re) => re.test(command))
}

/** The ids of the calls in these events that can change something outside this machine. */
export const outwardCalls = (events: readonly RuntimeEvent[]): string[] =>
  events.flatMap((event) => (event.type === 'tool.started' && isOutward(event.call) ? [event.call.callId] : []))
