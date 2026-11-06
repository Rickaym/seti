import { navigate } from '@/lib/route'

/** What another view fixes for the next agent, such as the pull request it should work on. */
export interface StartContext {
  label: string
  prompt: string
  title: string
  repo_ids: string[]
  ref: string
  pr_urls: string[]
}

let pending: StartContext | null = null

/** Opens the start page, carrying `context` there when given. */
export function openStartPage(context: StartContext | null = null): void {
  pending = context
  navigate('agents', 'new')
}

export const startContext = (): StartContext | null => pending

export function clearStartContext(): void {
  pending = null
}
