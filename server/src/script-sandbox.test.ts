import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { isolation, nodeArgs, sandboxCommand, type Isolation } from './script-sandbox.js'

const modes: Isolation[] = isolation().isolation === 'bwrap' ? ['node', 'bwrap'] : ['node']

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seti-script-sandbox-'))
  const granted = path.join(dir, 'granted')
  const secret = path.join(dir, 'secret.txt')
  fs.mkdirSync(granted)
  fs.writeFileSync(path.join(granted, 'engine.txt'), 'engine')
  fs.writeFileSync(secret, 'secret')
  const runner = path.join(dir, 'runner.mjs')
  const tryRead = (file: string) =>
    `(() => { try { return fs.readFileSync(${JSON.stringify(file)}, 'utf8') } catch (e) { return e.code } })()`
  fs.writeFileSync(
    runner,
    `import fs from 'node:fs'\nprocess.stdout.write(JSON.stringify([${tryRead(path.join(granted, 'engine.txt'))}, ${tryRead(secret)}, typeof process.env.HOME]))`,
  )
  return { runner, granted }
}

describe('the script sandbox', () => {
  it('grants Node one read per path and nothing else', () => {
    expect(nodeArgs(64)).toEqual([
      '--permission',
      '--max-old-space-size=64',
      '--max-semi-space-size=2',
      '--no-warnings',
    ])
    expect(nodeArgs(64, ['/a', '/b,c'])).toEqual([
      '--permission',
      '--allow-fs-read=/a',
      '--allow-fs-read=/b,c',
      '--max-old-space-size=64',
      '--max-semi-space-size=2',
      '--no-warnings',
    ])
  })

  it.each(modes)('lets a runner read what it was granted and no other file, under %s', (mode) => {
    const { runner, granted } = fixture()
    const { file, args } = sandboxCommand({ runner, reads: [granted] }, 64, mode)
    const result = spawnSync(file, args, { env: {}, timeout: 15_000 })
    const [engine, secret, home] = JSON.parse(result.stdout.toString()) as [string, string, string]
    expect(engine).toBe('engine')
    expect(['ERR_ACCESS_DENIED', 'ENOENT']).toContain(secret)
    expect(home).toBe('undefined')
  })
})
