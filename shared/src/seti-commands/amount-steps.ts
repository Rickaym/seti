import { coresLabel, cpuCapInput, cpuCapLabel } from '../cpu.js'
import { capLabel, mbLabel, memoryCapInput } from '../memory.js'
import type { SetiGrammar } from './rules.js'
import { option, type CommandOption, type CommandWorld, type FreeWord, type GrammarStep } from './world.js'

type AmountGrammar = Extract<SetiGrammar, { kind: 'amount' }>

const GB_CHOICES = [4, 6, 8, 12, 16, 24, 32]
const CORE_CHOICES = [1, 2, 3, 4, 6, 8, 12, 16]
const GB_WORD = /^(\d+(?:\.\d+)?)g(?:b)?$/i
const CORES_WORD = /^(\d+(?:\.5)?)$/
const MB_PER_GB = 1024

/** A memory key is the RAM cap in MiB; `default` goes back to the default cap. */
function memoryOption(world: CommandWorld, mb: number): CommandOption {
  const own = world.memory?.override?.max_mb
  return option({
    token: `${String(mb / MB_PER_GB)}g`,
    key: String(mb),
    label: mbLabel(mb),
    current: own === mb,
    unavailable: own === mb ? 'Already its cap' : null,
  })
}

function memoryFree(world: CommandWorld) {
  return (word: string): FreeWord => {
    const match = GB_WORD.exec(word)
    const mb = match === null ? NaN : Math.round(Number(match[1]) * MB_PER_GB)
    const swap = world.memory?.effective.swap_max_mb ?? 0
    const parsed = memoryCapInput.safeParse({ high_mb: mb, max_mb: mb, swap_max_mb: swap })
    if (!parsed.success) {
      return { refusal: match === null ? 'Give the cap in GB, such as 8g' : (parsed.error.issues[0]?.message ?? 'No') }
    }
    return { option: memoryOption(world, mb) }
  }
}

function cpuOption(world: CommandWorld, percent: number): CommandOption {
  const own = world.cpu?.cap.override?.quota_percent
  return option({
    token: String(percent / 100),
    key: String(percent),
    label: coresLabel(percent),
    current: own === percent,
    unavailable: own === percent ? 'Already its cap' : null,
  })
}

function cpuFree(world: CommandWorld) {
  return (word: string): FreeWord => {
    const match = CORES_WORD.exec(word)
    const percent = match === null ? NaN : Math.round(Number(match[1]) * 100)
    const max = world.cpu?.max_percent ?? Infinity
    if (!cpuCapInput.safeParse({ quota_percent: percent }).success) {
      return { refusal: 'Give the cap in cores, at least 0.5, such as 2' }
    }
    return percent > max ? { refusal: `This host has ${coresLabel(max)}` } : { option: cpuOption(world, percent) }
  }
}

/** Back to the default cap; `now` is the cap the agent has while it takes the default. */
const backToDefault = (isDefault: boolean, now: string | null) =>
  option({
    token: 'default',
    label: 'Default',
    detail: isDefault ? now : 'Back to the default cap',
    current: isDefault,
    unavailable: isDefault ? 'Already the default' : null,
  })

const memoryDefault = (world: CommandWorld) =>
  backToDefault(world.memory?.override === null, world.memory ? capLabel(world.memory.effective) : null)

const cpuDefaults = (world: CommandWorld) => [
  backToDefault(world.cpu?.cap.override === null, world.cpu ? cpuCapLabel(world.cpu.cap.effective) : null),
  option({ token: 'none', label: 'No cap', detail: 'No CPU ceiling' }),
]

/** The step after `/seti:memory` or `/seti:cpu`: a cap from the list or typed, or the default. */
export function amountStep(grammar: AmountGrammar, rest: readonly string[], world: CommandWorld): GrammarStep | null {
  if (rest.length > 0) {
    return rest.length === 1 ? { kind: 'end', rule: grammar.rule } : null
  }
  if (grammar.source === 'memory') {
    const options = [...GB_CHOICES.map((gb) => memoryOption(world, gb * MB_PER_GB)), memoryDefault(world)]
    return { kind: 'choose', prompt: 'a cap in GB, such as 8g', options, free: memoryFree(world), endRule: null }
  }
  const max = world.cpu?.max_percent ?? Infinity
  const cores = CORE_CHOICES.filter((count) => count * 100 <= max).map((count) => cpuOption(world, count * 100))
  return {
    kind: 'choose',
    prompt: 'a cap in cores, such as 2',
    options: [...cores, ...cpuDefaults(world)],
    free: cpuFree(world),
    endRule: null,
  }
}
