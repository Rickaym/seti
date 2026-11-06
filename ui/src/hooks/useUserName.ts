import type { UserSettings } from '@seti/shared'
import { usePolled } from '@/hooks/usePolled'
import { createPolledResource } from '@/lib/polled'

const userResource = createPolledResource<UserSettings>('/user', 60_000)

/** The name Seti addresses the user by; null until it loads. */
export function useUserName(): string | null {
  return usePolled(userResource).data?.name ?? null
}

/** Reads the name again now, after Settings changed it. */
export function refreshUserName(): void {
  userResource.refresh()
}

/** The user's settings as Seti holds them; undefined until they load. */
export function useUserSettings(): UserSettings | undefined {
  return usePolled(userResource).data
}
