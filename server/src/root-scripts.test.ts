import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'

/** pnpm 10 commands and aliases that run themselves instead of a script of the same name. */
const PNPM_BUILT_INS = new Set(
  `add approve-builds audit bin c cache cat-file cat-index ci config create dedupe deploy dislink dlx doctor env
  exec fetch find-hash get help i ignored-builds import init install install-test it la licenses link list ll ln
  ls m multi outdated pack patch patch-commit patch-remove prefix prune publish rb rebuild recursive remove rm
  root run run-script self-update server set setup store t un uninstall unlink up update upgrade why`.split(/\s+/),
)

const ALIAS = /^pnpm --silent run (\S+)$/

const manifest = z
  .object({ scripts: z.record(z.string(), z.string()) })
  .parse(JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '../../package.json'), 'utf8')))

describe('root package scripts', () => {
  const shadowed = Object.entries(manifest.scripts).filter(([name]) => PNPM_BUILT_INS.has(name))

  it('gives every script a name that `pnpm <name>` runs, or an alias of one', () => {
    const wrong = shadowed.filter(([, body]) => {
      const target = ALIAS.exec(body)?.[1]
      return target === undefined || PNPM_BUILT_INS.has(target) || !(target in manifest.scripts)
    })
    expect(wrong.map(([name]) => name)).toEqual([])
  })

  it('keeps `pnpm run doctor` working as an alias of seti:doctor', () => {
    expect(shadowed).toEqual([['doctor', 'pnpm --silent run seti:doctor']])
  })
})
