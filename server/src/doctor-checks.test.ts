import { describe, expect, it } from 'vitest'
import { claudeChecks } from './doctor-checks.js'

describe('claudeChecks', () => {
  it('reports a missing Claude login as the next step, not a problem', async () => {
    const login = (await claudeChecks(false)).find((check) => check.label === 'no Claude login found')
    expect(login?.state).toBe(process.platform === 'darwin' ? 'info' : 'warn')
    expect(login?.fix).toMatch(/^Next: run `claude` and \/login/)
  })

  it('accepts a long-lived token from Settings, Credentials', async () => {
    const checks = await claudeChecks(true)
    expect(checks.some((check) => check.state === 'ok' && check.label.startsWith('long-lived token'))).toBe(true)
  })
})
