import { hostMatches } from './connections.js'
import type { StoredRuntime } from './runtimes/stored.js'

/** US dollars per million tokens. */
interface TokenRate {
  input: number
  cachedInput: number
  output: number
}

/** A model's rates at short context, and above its table's long-context line. */
interface ModelPrice {
  short: TokenRate
  long: TokenRate
}

/** A provider's public prices as read on `asOf`; an estimate, since the bill is the provider's. */
interface PriceTable {
  asOf: string
  source: string
  /** Input tokens in one model call above which the long context rates apply. */
  longContextAbove: number
  models: Readonly<Record<string, ModelPrice>>
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
    longContextAbove: 272_000,
    models: {
      'gpt-5.5': { short: rate(5, 0.5, 30), long: rate(10, 1, 45) },
      'gpt-5.6-luna': { short: rate(0.2, 0.02, 1.2), long: rate(0.4, 0.04, 1.8) },
      'gpt-5.6-sol': { short: rate(4, 0.4, 20), long: rate(8, 0.8, 30) },
      'gpt-5.6-terra': { short: rate(2, 0.2, 12), long: rate(4, 0.4, 18) },
      'gpt-6-astra': { short: rate(10, 1, 50), long: rate(20, 2, 75) },
      'gpt-6-luna': { short: rate(0.1, 0.01, 0.5), long: rate(0.2, 0.02, 0.75) },
      'gpt-6-sol': { short: rate(2, 0.2, 10), long: rate(4, 0.4, 15) },
      'gpt-6.1-sol': { short: rate(2, 0.1, 10), long: rate(4, 0.2, 15) },
      'gpt-6.1-terra': { short: rate(1, 0.05, 5), long: rate(2, 0.1, 7.5) },
      'gpt-6.2-astra': { short: rate(8, 0.4, 40), long: rate(16, 0.8, 60) },
      'gpt-6.2-sol': { short: rate(2, 0.1, 10), long: rate(4, 0.2, 15) },
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
