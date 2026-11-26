import type { GitHubTokenMode } from './sandbox.js'

export interface SystemInfo {
  permission_mode: string
  /** Whether task sessions run sandboxed by default, and the GitHub token they get. */
  sandbox: { enabled: boolean; token_mode: GitHubTokenMode }
  /** The UI build the server hands out now, as index.html names it; null when none is built. */
  build: string | null
}

export interface Envelope<T> {
  data: T
  meta: Record<string, unknown>
}

export interface ApiError {
  error: { title: string; detail: string }
}
