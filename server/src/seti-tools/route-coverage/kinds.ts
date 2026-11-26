/** The rule a route refused to the EA and agents rests on, quoted from Seti's principles. */
export const PRINCIPLES = {
  security:
    "Security settings, credentials and connections stay the user's: the EA and agents' Seti tools never change them.",
  secrets: 'Secrets never land in logs, transcripts, audit details or chat, so no value reaches the EA or an agent.',
  signin: 'Sign-in, passkeys and paired devices decide who drives Seti; only the user changes them.',
  publishing: "Publishing data outside Seti is the user's call: the EA and agents never create share links.",
  installs: "Installing or updating code that runs in Seti or in agents needs the user's own consent.",
  commands: "Anyone who drives Seti's API can run commands as its user, so commands stay the user's.",
  voice: "Only the user writes an agent's prompts; the EA and agents reach it through the group chat.",
  irreversible: 'Deletions that cannot be undone stay with the user.',
  review: 'What reaches every agent, or what an agent reads from outside, is reviewed by the user.',
} as const

export type Principle = keyof typeof PRINCIPLES

/**
 * How the EA or agents do what one route lets the user do: an EA tool, a Seti tool at a level,
 * the same action as another route, the user's alone, view state, plumbing, or a known gap.
 */
export type Coverage =
  | { kind: 'ea'; tool: string; onWord?: string }
  | { kind: 'agent'; tool: string; level: 'self' | 'full' }
  | { kind: 'same'; route: string }
  | { kind: 'user'; principle: Principle; why: string }
  | { kind: 'ui'; why: string }
  | { kind: 'plumbing'; why: string }
  | { kind: 'gap'; why: string }

/** Every route by its method and path exactly as Hono lists it, such as 'GET /api/tasks/:id'. */
export type CoverageTable = Readonly<Record<string, Coverage>>

/** The EA does it with this tool; agents at Full get the same tool unless parity lists it. */
export const ea = (tool: string): Coverage => ({ kind: 'ea', tool })

/**
 * The EA does it with this tool only on the user's own spoken or typed yes to its read-back,
 * which ea-guard.ts checks; `row` names the approved row and what stays the user's. Agents get
 * none of it: the tool must be in parity's NOT_FOR_AGENTS.
 */
export const eaOnWord = (tool: string, row: string): Coverage => ({ kind: 'ea', tool, onWord: row })

/** The same action as another declared route, such as a summary or a batch form. */
export const same = (route: string): Coverage => ({ kind: 'same', route })

/** Refused to the EA and agents on purpose, resting on a principle. */
export const user = (principle: Principle, why: string): Coverage => ({ kind: 'user', principle, why })

/** View state of one browser, or the user's own prompt box. */
export const ui = (why: string): Coverage => ({ kind: 'ui', why })

/** Called by a program, such as the EA's voice bot, a hook or a paired device. */
export const plumbing = (why: string): Coverage => ({ kind: 'plumbing', why })

/** A known gap: the EA should do it and cannot yet. */
export const gap = (why: string): Coverage => ({ kind: 'gap', why })
