import type {
  CanUseTool,
  HookCallback,
  HookEvent,
  HookCallbackMatcher,
  PreToolUseHookInput,
} from '@anthropic-ai/claude-agent-sdk'
import { claudeToolCall, urlAllowed, WEBFETCH_BLOCKED, type Task } from '@seti/shared'
import { guardCommand, type GuardScope } from './permission-guard.js'
import { policyMode } from './policy/claude-call.js'
import { decide } from './policy/evaluate.js'
import { namedPaths } from './policy/named-paths.js'
import { ShadowTracker, type ShadowRecord } from './policy/shadow.js'
import { sourcedRules } from './policy/sources.js'
import { policyCall } from './policy/tool-call.js'
import type { PolicyCall, PolicyContext } from './policy/types.js'
import { resolvePaths } from './resolve-paths.js'
import { adapterFor, DEFAULT_RUNTIME } from './runtimes/registry.js'
import { guardScope, ruleSources, workingDirs } from './session-options.js'
import { allowedFor } from './store/change-requests.js'
import { policyShadow } from './store/policy-shadow.js'

/** How long one read of an agent's rules serves its calls; a rule changed meanwhile counts late. */
const RULES_TTL_MS = 5000

type Rules = Omit<PolicyContext, 'mode'>

/** What Seti's own hooks refuse before any rule: the shell guard, and the sandbox's web allowlist. */
function refusal(call: PolicyCall, scope: GuardScope, allowed: readonly string[]): string | null {
  if (call.command !== undefined) {
    return guardCommand(call.command, scope)
  }
  const blocked =
    scope.sandboxed && call.name === 'WebFetch' && !(call.url !== undefined && urlAllowed(call.url, allowed))
  return blocked ? WEBFETCH_BLOCKED : null
}

async function rulesOf(task: Task, sandboxed: boolean): Promise<Rules> {
  const scope = guardScope(task, sandboxed)
  const allowed = sandboxed ? await allowedFor(task.id) : []
  return {
    rules: sourcedRules(await ruleSources(task)),
    cwd: task.cwd,
    dirs: [task.cwd, ...workingDirs(task)],
    home: scope.home,
    classifier: adapterFor(DEFAULT_RUNTIME).capabilities.gate.classifier,
    guard: (call) => refusal(call, scope, allowed),
  }
}

const today = () => new Date().toISOString().slice(0, 10)

/** A decision that took longer counts as slow; it ran after the hook had answered either way. */
const SLOW_MS = 50

/** Names what went wrong without its message, which could quote a call's input or a rule. */
const complain = (task: Task, what: string) => (e: unknown) => {
  process.stderr.write(`policy shadow: task ${task.id}: ${what}: ${e instanceof Error ? e.name : 'error'}\n`)
}

export interface Shadow {
  hooks: Partial<Record<HookEvent, HookCallbackMatcher[]>>
  /** The runtime's permission callback, noting each call it asks about first. */
  observe: (decide: CanUseTool) => CanUseTool
}

/**
 * Computes Seti's own decision on each of the session's calls beside Claude Code's and counts
 * how the two compare. It never answers a hook or a callback differently: Claude Code decides.
 * Every hook answers at once; the decision runs on a later turn of the event loop, and a failure
 * there is counted and logged, never thrown.
 */
export function shadowHooks(task: Task, sandboxed: boolean, session: AbortSignal): Shadow {
  const unsaved = complain(task, 'count not saved')
  const failed = (e: unknown) => {
    complain(task, 'decision failed')(e)
    policyShadow.failed(today()).catch(unsaved)
  }
  const quietly = (work: () => void) => {
    try {
      work()
    } catch (e) {
      failed(e)
    }
  }
  const tracker = new ShadowTracker((entry: ShadowRecord) => {
    policyShadow.count(entry, today()).catch(unsaved)
  })
  session.addEventListener(
    'abort',
    () => {
      quietly(() => {
        tracker.close()
      })
    },
    { once: true },
  )
  let cached: { at: number; rules: Promise<Rules> } | null = null
  const rules = async () => {
    if (cached === null || Date.now() - cached.at > RULES_TTL_MS) {
      cached = { at: Date.now(), rules: rulesOf(task, sandboxed) }
    }
    return cached.rules
  }

  const judge = async (input: PreToolUseHookInput) => {
    const given = policyCall(claudeToolCall(input.tool_use_id, input.tool_name, input.tool_input))
    const mode = policyMode(input.permission_mode)
    const ctx = { ...(await rules()), mode }
    const resolved = await resolvePaths(namedPaths(given, ctx), [ctx.cwd, ...ctx.dirs, ctx.home])
    const call = resolved.size === 0 ? given : { ...given, resolved }
    const started = performance.now()
    const decision = decide(call, ctx)
    const slow = performance.now() - started > SLOW_MS
    const facts = { kind: call.kind, tool: call.mcp === undefined ? call.name : 'mcp', mode, sandboxed, slow }
    tracker.decided(input.tool_use_id, facts, decision)
  }

  const before: HookCallback = async (input) => {
    if (input.hook_event_name === 'PreToolUse') {
      setImmediate(() => {
        judge(input).catch(failed)
      })
    }
    return Promise.resolve({})
  }

  const after: HookCallback = async (input) => {
    quietly(() => {
      if (input.hook_event_name === 'PostToolUse') {
        tracker.observed(input.tool_use_id, 'allow')
      } else if (input.hook_event_name === 'PostToolUseFailure') {
        tracker.observed(input.tool_use_id, input.is_interrupt === true ? 'interrupted' : 'allow')
      } else if (input.hook_event_name === 'PermissionDenied') {
        tracker.observed(input.tool_use_id, 'deny')
      }
    })
    return Promise.resolve({})
  }

  return {
    hooks: {
      PreToolUse: [{ hooks: [before] }],
      PostToolUse: [{ hooks: [after] }],
      PostToolUseFailure: [{ hooks: [after] }],
      PermissionDenied: [{ hooks: [after] }],
    },
    observe: (decideCall) => async (tool, input, options) => {
      quietly(() => {
        tracker.observed(options.toolUseID, 'ask')
      })
      return decideCall(tool, input, options)
    },
  }
}
