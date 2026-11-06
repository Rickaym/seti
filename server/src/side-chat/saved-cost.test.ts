import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { savedTotal, sessionFile } from './saved-cost.js'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seti-saved-cost-'))
const costLine = (total: number) => JSON.stringify({ type: 'cost-state', totalCostUSD: total, modelUsage: {} })

function write(name: string, lines: string[]): string {
  const file = path.join(dir, name)
  fs.writeFileSync(file, `${lines.join('\n')}\n`)
  return file
}

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('savedTotal', () => {
  it('reads the newest total the session saved', () => {
    const file = write('two.jsonl', [costLine(0.25), '{"type":"user"}', costLine(0.75), '{"type":"assistant"}'])
    expect(savedTotal(file)).toBe(0.75)
  })

  it('finds a total far behind the end, across lines longer than a read', () => {
    const long = JSON.stringify({ type: 'assistant', text: 'x'.repeat(1_500_000) })
    const file = write('long.jsonl', [costLine(2.5), long, long, '{"type":"user"}'])
    expect(savedTotal(file)).toBe(2.5)
  })

  it('counts from zero without a saved total or a file', () => {
    expect(savedTotal(write('none.jsonl', ['{"type":"user"}', '{"type":"cost-state"']))).toBe(0)
    expect(savedTotal(path.join(dir, 'missing.jsonl'))).toBe(0)
  })

  it("names the file in the project folder of the agent's working directory", () => {
    expect(sessionFile('abc', '/home/me/repo', '/home/me/.claude')).toBe(
      '/home/me/.claude/projects/-home-me-repo/abc.jsonl',
    )
  })
})
