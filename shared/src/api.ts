import type { GitHubTokenMode } from './sandbox.js'

export interface SystemInfo {
  permission_mode: string
  /** Whether task sessions run sandboxed by default, and the GitHub token they get. */
  sandbox: { enabled: boolean; token_mode: GitHubTokenMode }
}

export interface Envelope<T> {
  data: T
  meta: Record<string, unknown>
}

export interface ApiError {
  error: { title: string; detail: string }
}
