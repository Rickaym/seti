import {
  accountStatusSchema,
  type AccountStatus,
  type ClaudeLogin,
  type ClaudeLogins,
  type SignInStart,
} from '@seti/shared'
import { toast } from 'sonner'
import { apiDelete, apiPatch, apiPost, errorText } from '@/api'
import { usePolled } from '@/hooks/usePolled'
import { createPolledResource } from '@/lib/polled'

const accountResource = createPolledResource('/account', 60_000, { schema: accountStatusSchema })

export const useAccount = () => usePolled(accountResource)

/** Probes the login again on the server, then refreshes every subscriber. */
export async function recheckAccount(): Promise<void> {
  await apiPost<AccountStatus>('/account/refresh')
  accountResource.refresh()
}

export const activeLogin = (logins: ClaudeLogins): ClaudeLogin | null =>
  logins.accounts.find((login) => login.id === logins.active_id) ?? null

/** Makes a saved login the one Claude Code uses; a toast names it, or the failure. */
export async function switchLogin(login: Pick<ClaudeLogin, 'id' | 'name'>): Promise<boolean> {
  try {
    const result = await apiPost<{ login: ClaudeLogin; kept: ClaudeLogin | null }>(
      `/account/logins/${encodeURIComponent(login.id)}/switch`,
      {},
    )
    const kept = result.kept === null ? '' : ` The previous login is saved as ${result.kept.name}.`
    toast.success(`Using ${result.login.name}`, {
      description: `Agents switch on their next turn.${kept}`,
    })
    return true
  } catch (e) {
    toast.error(errorText(e))
    return false
  } finally {
    accountResource.refresh()
  }
}

export async function saveLogin(name: string): Promise<ClaudeLogin> {
  const login = await apiPost<ClaudeLogin>('/account/logins', { name })
  accountResource.refresh()
  return login
}

export async function renameLogin(id: string, name: string): Promise<ClaudeLogin> {
  const login = await apiPatch<ClaudeLogin>(`/account/logins/${encodeURIComponent(id)}`, { name })
  accountResource.refresh()
  return login
}

export async function removeLogin(id: string): Promise<void> {
  await apiDelete(`/account/logins/${encodeURIComponent(id)}`)
  accountResource.refresh()
}

export const startSignIn = async (name: string) => apiPost<SignInStart>('/account/sign-in', { name })

export async function finishSignIn(id: string, code: string): Promise<{ login: ClaudeLogin; created: boolean }> {
  const result = await apiPost<{ login: ClaudeLogin; created: boolean }>(`/account/sign-in/${encodeURIComponent(id)}`, {
    code,
  })
  accountResource.refresh()
  return result
}

export const cancelSignIn = async (id: string) => apiDelete(`/account/sign-in/${encodeURIComponent(id)}`)
