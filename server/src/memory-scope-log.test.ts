import { spawn } from 'node:child_process'
import { once } from 'node:events'
import type { MemoryReport } from '@seti/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { launch, onMemoryEvent, type ScopeHost } from './memory-scope.js'
import { kernelOomKills } from './oom-guard.js'

vi.mock(import('./oom-guard.js'), async (original) => ({
  ...(await original()),
  kernelOomKills: vi.fn(),
}))

const host: ScopeHost = {
  systemdRun: 'systemd-run',
  systemctl: 'systemctl',
  runtimeDir: '/run/user/0',
  bindTo: null,
  cpu: false,
}
const cap = { high_mb: 64, max_mb: 64, swap_max_mb: 0 }
const kernelLog = vi.mocked(kernelOomKills)

/** Runs `code` as a scope Seti never finds, as when systemd removes it before Seti looks. */
async function runGone(taskId: string, code: string) {
  const child = launch({ host, taskId, kind: 'shell', cap, cpu: { quota_percent: null } }, process.execPath, [], () =>
    spawn(process.execPath, ['-e', code], { stdio: 'ignore' }),
  )
  await once(child, 'exit')
  return child.pid ?? 0
}

describe('a scope gone before Seti reads its counts', () => {
  const reports: [string, MemoryReport][] = []

  beforeEach(() => {
    reports.length = 0
    kernelLog.mockReset()
    onMemoryEvent((taskId, report) => reports.push([taskId, report]))
  })

  it('notes an OOM kill the kernel log names', async () => {
    let pid = 0
    kernelLog.mockImplementation(async () => Promise.resolve([{ pid, comm: 'node' }]))
    pid = await runGone('gone-oom', "process.kill(process.pid, 'SIGKILL')")
    await vi.waitFor(() => {
      expect(reports).toEqual([
        ['gone-oom', { event: 'oom_kill', cap, kind: 'shell', victims: { root: true, names: [] } }],
      ])
    })
  })

  it('notes nothing for a kill the kernel log does not name, after one wait for it', async () => {
    kernelLog.mockResolvedValue([])
    await runGone('gone-killed', "process.kill(process.pid, 'SIGKILL')")
    await vi.waitFor(() => {
      expect(kernelLog).toHaveBeenCalledTimes(2)
    })
    expect(reports).toEqual([])
  })

  it('leaves the kernel log alone for a run that ends on its own', async () => {
    await runGone('gone-clean', 'process.exit(1)')
    await new Promise((resolve) => setTimeout(resolve, 1000))
    expect(kernelLog).not.toHaveBeenCalled()
  })
})
