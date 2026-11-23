import fs from 'node:fs/promises'
import os from 'node:os'
import type { UsageWindow } from '@seti/shared'
import { accountStatus } from '../account.js'
import { SETI_HOME } from '../config.js'

/** When a nightly dream waits (`dream_gates`): plan use, host load and free disk. */
const DREAM_GATES = { fiveHour: 60, weekly: 85, loadPerCore: 0.75, freeBytes: 5 * 1024 ** 3 }

/** Why the plan's use holds dreams back, or null; without plan windows only the dollar caps apply. */
export function planGate(windows: readonly UsageWindow[]): string | null {
  for (const window of windows) {
    const used = window.utilization ?? 0
    if (window.key === 'five_hour' && used >= DREAM_GATES.fiveHour) {
      return `plan limit: the 5-hour window is at ${String(Math.round(used))}%`
    }
    if (window.key.startsWith('seven_day') && used >= DREAM_GATES.weekly) {
      return `plan limit: ${window.label} is at ${String(Math.round(used))}%`
    }
  }
  return null
}

/** Why the host is too busy, or null: the 1-minute load past the share of its cores. */
export function loadGate(load = os.loadavg()[0] ?? 0, cores = os.availableParallelism()): string | null {
  const limit = DREAM_GATES.loadPerCore * cores
  return load >= limit ? `host busy: load ${load.toFixed(1)} of ${limit.toFixed(1)}` : null
}

/**
 * Why free disk holds dreams back, or null: every disk Seti writes to, the root one (which holds
 * PostgreSQL on many hosts) and the one with Seti's data and the agents' folders, needs room.
 */
export async function diskGate(paths: readonly string[] = ['/', os.homedir(), SETI_HOME]): Promise<string | null> {
  for (const path of [...new Set(paths)]) {
    const stat = await fs.statfs(path).catch(() => null)
    if (stat !== null && stat.bavail * stat.bsize < DREAM_GATES.freeBytes) {
      return `disk low: less than 5 GB free on ${path}`
    }
  }
  return null
}

/** The first gate that holds a nightly dream back now, or null when every one passes. */
export async function dreamGates(): Promise<string | null> {
  const status = await accountStatus({ refresh: false }).catch(() => null)
  return planGate(status?.usage?.windows ?? []) ?? loadGate() ?? (await diskGate())
}
