import { memoryCapInput, throttles, type MemoryCap } from '@seti/shared'

/** A memory cap as typed, in GB; `high` counts only while `throttle` is on. */
export interface MemoryCapForm {
  max: string
  swap: string
  throttle: boolean
  high: string
}

const gb = (mb: number) => String(Math.round((mb / 1024) * 100) / 100)
const mb = (text: string) => Math.round(Number(text) * 1024)

export const toMemoryForm = (cap: MemoryCap): MemoryCapForm => ({
  max: gb(cap.max_mb),
  swap: gb(cap.swap_max_mb),
  throttle: throttles(cap),
  high: gb(throttles(cap) ? cap.high_mb : Math.round((cap.max_mb * 2) / 3)),
})

export function parseMemoryForm(form: MemoryCapForm): { cap: MemoryCap } | { error: string } {
  const values = form.throttle ? [form.high, form.max, form.swap] : [form.max, form.swap]
  if (values.some((value) => value.trim() === '' || !Number.isFinite(Number(value)))) {
    return { error: 'Give each size as a number of GB' }
  }
  const max = mb(form.max)
  const result = memoryCapInput.safeParse({
    high_mb: form.throttle ? mb(form.high) : max,
    max_mb: max,
    swap_max_mb: mb(form.swap),
  })
  return result.success ? { cap: result.data } : { error: result.error.issues[0]?.message ?? 'Not a valid cap' }
}

export const sameMemoryForm = (a: MemoryCapForm, b: MemoryCapForm) =>
  a.max === b.max && a.swap === b.swap && a.throttle === b.throttle && (!a.throttle || a.high === b.high)
