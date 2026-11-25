import {
  isSecurityAccess,
  type AccessItem,
  type CredentialProfile,
  type CredentialsOverview,
  type ProfileSummary,
  type TaskAccessView,
} from '@seti/shared'
import { apiGet } from '@/api'
import { accessLabel } from '@/panels/access/access'

/** What picking a credential turns on and off for an agent, beside the choices it keeps. */
export interface PickConsequence {
  profile: ProfileSummary
  on: string[]
  off: string[]
  own: number
}

const bySecurity = (a: AccessItem, b: AccessItem) => Number(isSecurityAccess(b.kind)) - Number(isSecurityAccess(a.kind))

function turned(view: TaskAccessView, next: CredentialProfile, now: CredentialProfile | undefined) {
  const set = new Map(next.access.items.map((entry) => [`${entry.kind}:${entry.id}`, entry.enabled]))
  const moved = view.items
    .filter((item) => item.override === null)
    .filter((item) => (set.get(`${item.kind}:${item.id}`) ?? item.default_enabled) !== item.enabled)
    .toSorted(bySecurity)
  const hostsNow = now?.access.hosts ?? []
  return {
    on: [
      ...moved.filter((item) => !item.enabled).map(accessLabel),
      ...next.access.hosts.filter((host) => !hostsNow.includes(host)).map((host) => `host ${host}`),
    ],
    off: [
      ...moved.filter((item) => item.enabled).map(accessLabel),
      ...hostsNow.filter((host) => !next.access.hosts.includes(host)).map((host) => `host ${host}`),
    ],
  }
}

/** Reads what the agent would follow on the credential, for the dialog before the switch. */
export async function pickConsequence(taskId: string, profile: ProfileSummary): Promise<PickConsequence> {
  const [view, overview] = await Promise.all([
    apiGet<TaskAccessView>(`/tasks/${taskId}/access`),
    apiGet<CredentialsOverview>('/credentials'),
  ])
  const next = overview.profiles.find((entry) => entry.id === profile.id)
  const now = overview.profiles.find((entry) => entry.id === view.profile.id)
  const own = view.items.filter((item) => item.override !== null).length
  return { profile, own, ...(next === undefined ? { on: [], off: [] } : turned(view, next, now)) }
}
