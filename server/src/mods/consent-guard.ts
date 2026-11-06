import { MOD_PACKAGE_LIMITS, STEP_UP_REFUSAL } from '@seti/shared'
import { currentRequestSource } from '../access.js'
import { HttpError } from '../http.js'
import { authEnforced } from '../seti-auth.js'
import { sessionRows } from '../store/auth.js'

/**
 * Refuses anyone but the user from their own browser session or on this machine: never the EA,
 * an agent, a mod or a paired device. With stepUp, while Require passkey is on, a browser session
 * also needs a passkey check from the last five minutes.
 */
export async function requireUserConsent({ stepUp }: { stepUp: boolean }, at: Date = new Date()): Promise<void> {
  const source = currentRequestSource()
  if (source?.via !== 'session' && source?.via !== 'local') {
    throw new HttpError(403, 'Only the user does this, signed in to Seti with a passkey or on this machine')
  }
  if (!stepUp || source.via !== 'session' || !(await authEnforced())) {
    return
  }
  const stepped = await sessionRows.steppedUpAt(source.sessionId)
  if (stepped === null || at.getTime() - Date.parse(stepped) > MOD_PACKAGE_LIMITS.stepUpMs) {
    throw new HttpError(403, STEP_UP_REFUSAL)
  }
}
