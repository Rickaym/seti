import { z } from 'zod'
import { terminalStatusSchema } from './terminal.js'

export const BACKGROUND_SHELL_STATUSES = ['running', 'completed', 'failed', 'killed'] as const
export type BackgroundShellStatus = (typeof BACKGROUND_SHELL_STATUSES)[number]

/** Why Claude Code itself stopped a shell: its background time limit, or the host low on memory. */
export const SHELL_STOP_CAUSES = ['time_limit', 'low_memory'] as const
export type ShellStopCause = (typeof SHELL_STOP_CAUSES)[number]

/** Claude Code, a Seti helper, a tool such as an MCP server, or a command the agent ran. */
export const AGENT_PROCESS_KINDS = ['agent', 'seti', 'tool', 'command'] as const
export type AgentProcessKind = (typeof AGENT_PROCESS_KINDS)[number]

/** A command the agent runs in the background with Bash or Monitor, from its messages. */
export const backgroundShellSchema = z.object({
  /** Claude Code's task id for it, which TaskStop and the output file name use. */
  id: z.string(),
  tool_use_id: z.string(),
  tool: z.string(),
  /** Secrets redacted, clipped. */
  command: z.string(),
  description: z.string().nullable(),
  status: z.enum(BACKGROUND_SHELL_STATUSES),
  /** Set when Claude Code stopped it on its own rather than the agent or the user. */
  stop_cause: z.enum(SHELL_STOP_CAUSES).nullable(),
  exit_code: z.number().int().nullable(),
  started_at: z.string(),
  ended_at: z.string().nullable(),
  /** Started by a subagent, which stops it when it gives its final report. */
  subagent: z.boolean(),
  /** Host pid of its shell while it runs and Seti can find it. */
  pid: z.number().int().nullable(),
  has_output: z.boolean(),
})

export type BackgroundShell = z.infer<typeof backgroundShellSchema>

export const agentProcessSchema = z.object({
  pid: z.number().int(),
  /** The pid inside the task's sandbox, which the agent sees; null outside one. */
  ns_pid: z.number().int().nullable(),
  ppid: z.number().int(),
  /** With the clock-tick start time, tells this process from a later one given the same pid. */
  start_ticks: z.number().int().nonnegative(),
  name: z.string(),
  /** Command line, secrets redacted, clipped. */
  command: z.string(),
  kind: z.enum(AGENT_PROCESS_KINDS),
  /** The background shell whose process tree holds it. */
  shell_id: z.string().nullable(),
  /** Nesting below the task's root process, for drawing the tree. */
  depth: z.number().int().nonnegative(),
  /** Percent of one CPU since the previous look, or averaged over its life on the first look. */
  cpu_percent: z.number().nonnegative().nullable(),
  rss_bytes: z.number().nonnegative(),
  elapsed_s: z.number().nonnegative(),
})

export type AgentProcess = z.infer<typeof agentProcessSchema>

/** One systemd scope holding an agent's process tree, with what it uses against its cap. */
export const memoryScopeSchema = z.object({
  unit: z.string(),
  /** The agent's Claude Code, its side chat, a command the user ran in its shell, or the terminal. */
  kind: z.enum(['agent', 'side_chat', 'shell', 'terminal']),
  current_bytes: z.number().nonnegative(),
  swap_bytes: z.number().nonnegative(),
  high_bytes: z.number().nonnegative(),
  max_bytes: z.number().nonnegative(),
  swap_max_bytes: z.number().nonnegative(),
  /** Processes the kernel stopped at the cap since the scope started. */
  oom_kills: z.number().int().nonnegative(),
  /** Times the scope went over the throttle point. */
  high_events: z.number().int().nonnegative(),
})

export type MemoryScope = z.infer<typeof memoryScopeSchema>

/** One scope's CPU use over the last short window, against its ceiling, from its cpu.stat. */
export const cpuScopeSchema = z.object({
  unit: z.string(),
  kind: memoryScopeSchema.shape.kind,
  /** Percent of one core over the window: 150 is one and a half cores busy. */
  usage_percent: z.number().nonnegative(),
  /** The ceiling in percent of one core, or null with none. */
  quota_percent: z.number().int().positive().nullable(),
  weight: z.number().int().positive(),
  /** Periods the kernel paused the scope at its ceiling, and for how long, since it started. */
  nr_throttled: z.number().int().nonnegative(),
  throttled_usec: z.number().nonnegative(),
  /** The kernel paused it at the ceiling during the window. */
  throttled_now: z.boolean(),
})

export type CpuScope = z.infer<typeof cpuScopeSchema>

export const agentProcessesSchema = z.object({
  sampled_at: z.string(),
  /** The task's Claude Code process is open, so its shells and processes can run. */
  open: z.boolean(),
  sandboxed: z.boolean(),
  shells: z.array(backgroundShellSchema),
  /** Parents before their children; empty while no process of the task runs. */
  processes: z.array(agentProcessSchema),
  /** The scopes of the agent that hold it to its memory cap; empty where the host has none. */
  memory: z.array(memoryScopeSchema),
  /** The same scopes' CPU use against their ceiling; empty without a delegated cpu controller. */
  cpu: z.array(cpuScopeSchema),
  /** The terminals the user opened for the agent that still run. */
  terminals: z.array(terminalStatusSchema),
  /** Running background shells, commands outside them and terminals, for the header badge. */
  running: z.number().int().nonnegative(),
})

export type AgentProcesses = z.infer<typeof agentProcessesSchema>

export const shellOutputSchema = z.object({
  id: z.string(),
  /** The end of the output, secrets redacted. */
  text: z.string(),
  size_bytes: z.number().int().nonnegative(),
  truncated: z.boolean(),
})

export type ShellOutput = z.infer<typeof shellOutputSchema>

export const shellParams = z.object({
  id: z.string().min(1),
  shell_id: z.string().regex(/^[\w-]{1,64}$/),
})

export const stopProcessInput = z.object({
  pid: z.number().int().positive(),
  start_ticks: z.number().int().nonnegative(),
})

export type StopProcessInput = z.infer<typeof stopProcessInput>
