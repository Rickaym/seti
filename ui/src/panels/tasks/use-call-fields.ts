import type { PermissionRequest } from '@seti/shared'
import { useState } from 'react'

/** The call's top-level text fields by name, from a request's input; none for a non-object. */
function textFieldsOf(request: PermissionRequest): Record<string, string> {
  try {
    const input: unknown = JSON.parse(request.input)
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
      return {}
    }
    return Object.fromEntries(
      Object.entries(input).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
    )
  } catch {
    return {}
  }
}

export interface CallFieldValues {
  values: Record<string, string>
  /** The fields whose value differs from the call's, which an allow sends. */
  changed: Record<string, string>
  set: (key: string, value: string) => void
}

/** The user's values for an editable call's text fields; an uneditable call has none. */
export function useCallFields(request: PermissionRequest): CallFieldValues {
  const [original] = useState(() => (request.editable ? textFieldsOf(request) : {}))
  const [values, setValues] = useState(original)
  const changed = Object.fromEntries(Object.entries(values).filter(([key, value]) => original[key] !== value))
  return {
    values,
    changed,
    set: (key, value) => {
      setValues((prev) => ({ ...prev, [key]: value }))
    },
  }
}
