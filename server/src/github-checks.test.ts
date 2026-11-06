import { describe, expect, it } from 'vitest'
import { readRollup } from './github-checks.js'

interface RunSpec {
  conclusion: string | null
  workflow: string | null
  runId?: number
  status?: string
}

const run = (name: string, { conclusion, workflow, runId = 1, status = 'COMPLETED' }: RunSpec) => ({
  __typename: 'CheckRun' as const,
  name,
  status,
  conclusion,
  detailsUrl: null,
  checkSuite: workflow === null ? null : { workflowRun: { databaseId: runId, workflow: { name: workflow } } },
})

const status = (context: string, state: string) => ({
  __typename: 'StatusContext' as const,
  context,
  state,
  targetUrl: null,
})

describe('readRollup', () => {
  it('ignores runs a newer run of the same workflow replaced, as GitHub shows the PR', () => {
    const rollup = {
      state: 'FAILURE',
      contexts: {
        nodes: [
          run('Pipeline Tests', { conclusion: 'CANCELLED', workflow: 'Pipeline Tests', runId: 10 }),
          run('Bot Tests (group ${{ matrix.group }})', { conclusion: 'CANCELLED', workflow: 'Tests', runId: 11 }),
          run('Pipeline Tests', { conclusion: 'SUCCESS', workflow: 'Pipeline Tests', runId: 20 }),
          run('Bot Tests (group 1)', { conclusion: 'SUCCESS', workflow: 'Tests', runId: 21 }),
          run('gitleaks', { conclusion: 'SUCCESS', workflow: 'Security', runId: 5 }),
        ],
      },
    }
    const read = readRollup(rollup)
    expect(read.ci).toBe('success')
    expect(read.checks.map((check) => check.name)).toEqual(['Pipeline Tests', 'Bot Tests (group 1)', 'gitleaks'])
  })

  it('still fails on a failing check of the latest run, a failing status or a cancelled app check', () => {
    expect(
      readRollup({
        state: 'FAILURE',
        contexts: { nodes: [run('lint', { conclusion: 'FAILURE', workflow: 'CI', runId: 3 })] },
      }).ci,
    ).toBe('failure')
    expect(readRollup({ state: 'FAILURE', contexts: { nodes: [status('sonar', 'FAILURE')] } }).ci).toBe('failure')
    expect(
      readRollup({ state: 'FAILURE', contexts: { nodes: [run('app', { conclusion: 'CANCELLED', workflow: null })] } })
        .ci,
    ).toBe('failure')
  })

  it('is pending while a current check runs, neutral when every check skipped, null without a rollup', () => {
    const pending = {
      state: 'PENDING',
      contexts: { nodes: [run('e2e', { conclusion: null, workflow: 'CI', runId: 4, status: 'IN_PROGRESS' })] },
    }
    expect(readRollup(pending).ci).toBe('pending')
    expect(
      readRollup({
        state: 'SUCCESS',
        contexts: { nodes: [run('preview', { conclusion: 'SKIPPED', workflow: 'Deploy', runId: 2 })] },
      }).ci,
    ).toBe('neutral')
    expect(readRollup(null)).toEqual({ ci: null, checks: [] })
  })
})
