import type { SettingsPatchInput, SettingsPatchResult, SettingsWriteRefusal } from '@seti/shared'
import { toast } from 'sonner'
import { apiPatch, apiPost, errorText, RequestError } from '@/api'

/** What a JSON write came to: saved, or refused with the reasons the server gave. */
export type WriteOutcome = { saved: SettingsPatchResult } | { refused: SettingsWriteRefusal }

const isRefusal = (body: unknown): body is { error: SettingsWriteRefusal } =>
  typeof body === 'object' &&
  body !== null &&
  'error' in body &&
  typeof body.error === 'object' &&
  body.error !== null &&
  'problems' in body.error

/** Sends a JSON write; a refusal with reasons comes back as a value, anything else throws. */
export async function sendWrite(body: SettingsPatchInput): Promise<WriteOutcome> {
  try {
    return { saved: await apiPatch<SettingsPatchResult>('/settings-doc', body) }
  } catch (e) {
    if (e instanceof RequestError && isRefusal(e.body)) {
      return { refused: e.body.error }
    }
    throw e
  }
}

/** Says a write saved, with Undo through its revision, which reverts it as one change. */
export function announceSaved(result: SettingsPatchResult, onUndone: () => void): void {
  const revision = result.revision
  const count = result.changed.length
  toast.success(count === 1 ? 'Saved 1 setting' : `Saved ${String(count)} settings`, {
    action:
      revision === null
        ? undefined
        : {
            label: 'Undo',
            onClick: () => {
              apiPost(`/revisions/${String(revision)}/revert`, {}).then(onUndone, (e: unknown) => {
                toast.error(errorText(e), { duration: Infinity })
              })
            },
          },
  })
}
