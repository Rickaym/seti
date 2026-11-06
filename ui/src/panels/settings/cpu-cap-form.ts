import { cpuCapInput, cpuCapProblem, type CpuCap } from '@seti/shared'

/** A CPU cap as typed, in cores; `cores` counts only while `limited` is on. */
export interface CpuCapForm {
  limited: boolean
  cores: string
}

/** The cores a form shows when the cap is off and the user turns it on. */
const DEFAULT_CORES = '3'

export const toCpuForm = (cap: CpuCap): CpuCapForm => ({
  limited: cap.quota_percent !== null,
  cores: cap.quota_percent === null ? DEFAULT_CORES : String(cap.quota_percent / 100),
})

/** The cap a form holds on a host with `maxPercent` (nproc x 100), or what is wrong with it. */
export function parseCpuForm(form: CpuCapForm, maxPercent: number): { cap: CpuCap } | { error: string } {
  if (!form.limited) {
    return { cap: { quota_percent: null } }
  }
  const cores = Number(form.cores)
  if (form.cores.trim() === '' || !Number.isFinite(cores)) {
    return { error: 'Give the cap as a number of cores' }
  }
  const result = cpuCapInput.safeParse({ quota_percent: Math.round(cores * 100) })
  if (!result.success) {
    return { error: `The cap is ${result.error.issues[0]?.message ?? 'not valid'}` }
  }
  const problem = cpuCapProblem(result.data, maxPercent)
  return problem === null ? { cap: result.data } : { error: problem }
}

export const sameCpuForm = (a: CpuCapForm, b: CpuCapForm) =>
  a.limited === b.limited && (!a.limited || Number(a.cores) === Number(b.cores))
