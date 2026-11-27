import { hostMatches } from './connections.js'
import type { StoredRuntime } from './runtimes/stored.js'

/** US dollars per million tokens. */
interface TokenRate {
  input: number
  cachedInput: number
  output: number
}

/**
 * A model's rates from a day on: at short context, and above a line of input tokens per call
 * where the provider charges long-context rates.
 */
export interface PriceRow {
  /** The first day the rates apply, or null for rates in force when the table was read. */
  from: string | null
  short: TokenRate
  long: { above: number; rate: TokenRate } | null
}

/**
 * A provider's public prices as read on `asOf`, each model's rows oldest first, so a rise the
 * provider announced applies on its day; an estimate, since the bill is the provider's.
 */
interface PriceTable {
  asOf: string
  source: string
  models: Readonly<Record<string, readonly PriceRow[]>>
}

/**
 * A company that serves models to agents: the API its harness calls, the hosts the egress proxy
 * may sign for it, and its prices where Seti estimates the cost rather than the runtime.
 */
interface Provider {
  label: string
  /** The API's root as the harness addresses it; the harness dials it through Seti's proxy. */
  baseUrl: string
  /** The hosts its model calls go to, the only ones where its key is added. */
  hosts: readonly string[]
  /** What signs its calls: the host's Claude login, or a connection with a header on its hosts. */
  key: 'login' | 'connection'
  /** Null where the runtime reports dollars itself. */
  prices: PriceTable | null
}

const rate = (input: number, cachedInput: number, output: number): TokenRate => ({ input, cachedInput, output })

/** OpenAI's rates for a model at short context and above 272k input tokens per call. */
const openai = (short: TokenRate, long: TokenRate): readonly PriceRow[] => [
  { from: null, short, long: { above: 272_000, rate: long } },
]

/** Claude Code's provider; its agents sign in with the user's Claude login, which prices itself. */
const ANTHROPIC = {
  label: 'Anthropic',
  baseUrl: 'https://api.anthropic.com',
  hosts: ['api.anthropic.com'],
  key: 'login',
  prices: null,
} satisfies Provider

/** Codex's provider, with OpenAI's standard-tier rates for the models the pinned Codex lists. */
const OPENAI = {
  label: 'OpenAI',
  baseUrl: 'https://api.openai.com/v1',
  hosts: ['api.openai.com'],
  key: 'connection',
  prices: {
    asOf: '2026-11-24',
    source: 'https://developers.openai.com/api/docs/pricing',
    models: {
      'gpt-5.5': openai(rate(5, 0.5, 30), rate(10, 1, 45)),
      'gpt-5.6-luna': openai(rate(0.2, 0.02, 1.2), rate(0.4, 0.04, 1.8)),
      'gpt-5.6-sol': openai(rate(4, 0.4, 20), rate(8, 0.8, 30)),
      'gpt-5.6-terra': openai(rate(2, 0.2, 12), rate(4, 0.4, 18)),
      'gpt-6-astra': openai(rate(10, 1, 50), rate(20, 2, 75)),
      'gpt-6-luna': openai(rate(0.1, 0.01, 0.5), rate(0.2, 0.02, 0.75)),
      'gpt-6-sol': openai(rate(2, 0.2, 10), rate(4, 0.4, 15)),
      'gpt-6.1-sol': openai(rate(2, 0.1, 10), rate(4, 0.2, 15)),
      'gpt-6.1-terra': openai(rate(1, 0.05, 5), rate(2, 0.1, 7.5)),
      'gpt-6.2-astra': openai(rate(8, 0.4, 40), rate(16, 0.8, 60)),
      'gpt-6.2-sol': openai(rate(2, 0.1, 10), rate(4, 0.2, 15)),
    },
  },
} satisfies Provider

/** The providers Seti knows, built in; no user-defined provider exists. */
export const PROVIDERS = { anthropic: ANTHROPIC, openai: OPENAI } as const satisfies Record<string, Provider>

export type ProviderId = keyof typeof PROVIDERS

/** Whether a connection on these host patterns reaches the provider's model calls. */
export const reachesProvider = (provider: ProviderId, patterns: readonly string[]): boolean =>
  patterns.some((pattern) => PROVIDERS[provider].hosts.some((host) => hostMatches(pattern, host)))

/** The provider each runtime's agents reach, which signs their model calls. */
const RUNTIME_PROVIDERS: Record<StoredRuntime, ProviderId> = { claude: 'anthropic', codex: 'openai' }

/** The provider an agent on the runtime sends its model calls to. */
export const providerOf = (runtime: StoredRuntime): ProviderId => RUNTIME_PROVIDERS[runtime]
