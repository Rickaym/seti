import {
  PERMISSION_TIMEOUT_MINUTES,
  permissionTimeoutSchema,
  timeoutLabel,
  type PermissionTimeoutInput,
  type PermissionTimeoutMinutes,
} from '@seti/shared'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { apiGetValid, apiPut, errorText } from '@/api'
import { InfoTip } from '@/components/InfoTip'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { SettingRow, SettingsCard } from './layout'

const HINT =
  'Counts from when each request was raised. A new value applies to requests already waiting, so one older than it is denied at once.'

/** How long a permission request waits for an answer before Seti denies it, for every agent. */
export function RequestTimeout({ onChange }: { onChange: () => void }) {
  const [minutes, setMinutes] = useState<PermissionTimeoutMinutes | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    apiGetValid('/permissions/timeout', permissionTimeoutSchema, controller.signal)
      .then((settings) => {
        setMinutes(settings.request_timeout_minutes)
      })
      .catch(() => undefined)
    return () => {
      controller.abort()
    }
  }, [])

  const save = async (next: PermissionTimeoutMinutes) => {
    const before = minutes
    setMinutes(next)
    try {
      await apiPut('/permissions/timeout', { request_timeout_minutes: next } satisfies PermissionTimeoutInput)
      onChange()
    } catch (e) {
      setMinutes(before)
      toast.error(errorText(e), { duration: Infinity })
    }
  }

  return (
    <SettingsCard title="Requests">
      <SettingRow
        label="Request timeout"
        description="A request nobody answers in this time is denied, and the agent is told it timed out and goes on. It adds no rule."
      >
        <NativeSelect
          aria-label="Request timeout"
          size="sm"
          value={minutes === null ? '' : String(minutes)}
          disabled={minutes === null}
          onChange={(e) => {
            const next = PERMISSION_TIMEOUT_MINUTES.find((option) => String(option) === e.target.value)
            if (next !== undefined) {
              void save(next)
            }
          }}
        >
          {PERMISSION_TIMEOUT_MINUTES.map((option) => (
            <NativeSelectOption key={option} value={String(option)}>
              {timeoutLabel(option)}
            </NativeSelectOption>
          ))}
        </NativeSelect>
        <InfoTip label="About the request timeout" text={HINT} />
      </SettingRow>
    </SettingsCard>
  )
}
