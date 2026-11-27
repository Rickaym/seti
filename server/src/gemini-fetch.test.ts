import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { gzipSync } from 'node:zlib'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { findBinary } from './binaries.js'
import { entryIn, fetchGemini, holdsBundle, treeDigest, versionDir, type GeminiPin } from './gemini-fetch.js'
import { InstallError } from './pinned-download.js'
import { FakeRegistry } from './test-codex-registry.js'

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'seti-gemini-fetch-'))
const registry = new FakeRegistry()
beforeAll(async () => registry.start())
afterAll(async () => {
  await registry.close()
  for (const name of fs.readdirSync(scratch, { recursive: true, encoding: 'utf8' })) {
    if (fs.lstatSync(path.join(scratch, name)).isDirectory()) {
      fs.chmodSync(path.join(scratch, name), 0o700)
    }
  }
  fs.rmSync(scratch, { recursive: true, force: true })
})

/** A registry tarball of a bundle holding `files`, served by the registry, and its pin. */
function served(version: string, files: Record<string, string>, link?: string): GeminiPin {
  const dir = fs.mkdtempSync(path.join(scratch, 'pack-'))
  const bundle = path.join(dir, 'package', 'bundle')
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(bundle, name)), { recursive: true })
    fs.writeFileSync(path.join(bundle, name), text)
  }
  if (link !== undefined) {
    fs.symlinkSync('/etc/hostname', path.join(bundle, link))
  }
  fs.writeFileSync(path.join(dir, 'package', 'package.json'), '{}')
  const tar = path.join(dir, 'gemini.tar')
  execFileSync(findBinary('tar'), ['-cf', tar, '-C', dir, 'package'])
  const tarball = gzipSync(fs.readFileSync(tar), { level: 1 })
  const integrity = `sha512-${createHash('sha512').update(tarball).digest('base64')}`
  const pin = registry.pin({ version, tarball, integrity, sha256: '', hostSha256: '' })
  const url = Object.values(pin.platforms)[0]?.tarball ?? ''
  return { version, tarball: url, integrity, bundle: '' }
}

const FILES = { 'gemini.js': 'console.log("gemini")\n', 'chunk-a.js': 'a\n', 'builtin/skill/SKILL.md': 'skill\n' }

/** The bundle digest a pin names for `files`, read as Seti reads one. */
async function digestOf(files: Record<string, string>): Promise<string> {
  const dir = fs.mkdtempSync(path.join(scratch, 'digest-'))
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true })
    fs.writeFileSync(path.join(dir, name), text)
  }
  return treeDigest(dir)
}

const discarded: string[] = []
const discard = async (dir: string) => {
  discarded.push(dir)
  return Promise.resolve()
}

describe("fetching Seti's pinned Gemini CLI", () => {
  it('puts the checked bundle in place, read-only, once however often it is asked', async () => {
    const root = path.join(scratch, 'ok')
    const pin = { ...served('1.0.0', FILES), bundle: await digestOf(FILES) }
    const first = await fetchGemini({ pin, root, discard })
    expect(first).toEqual({ entry: entryIn(root, '1.0.0'), fetched: true })
    expect(fs.readFileSync(first.entry, 'utf8')).toBe(FILES['gemini.js'])
    expect(fs.statSync(first.entry).mode & 0o777).toBe(0o400)
    expect(fs.statSync(versionDir(root, '1.0.0')).mode & 0o777).toBe(0o500)
    expect(fs.existsSync(path.join(versionDir(root, '1.0.0'), 'package.json'))).toBe(false)
    expect(await fetchGemini({ pin, root, discard })).toEqual({ entry: first.entry, fetched: false })
    expect(await holdsBundle(root, { ...pin, bundle: '0'.repeat(64) })).toBe(false)
  })

  it('refuses a tarball that fails its sha512 and leaves no version folder', async () => {
    const root = path.join(scratch, 'sha512')
    const pin = { ...served('1.0.1', FILES), bundle: await digestOf(FILES) }
    const wrong = { ...pin, integrity: `sha512-${Buffer.alloc(64).toString('base64')}` }
    await expect(fetchGemini({ pin: wrong, root, discard })).rejects.toMatchObject({ reason: 'checksum' })
    expect(fs.existsSync(versionDir(root, '1.0.1'))).toBe(false)
    expect(discarded).toContain(path.join(root, '.staging-1.0.1'))
  })

  it('refuses a bundle that fails its sha256, or holds anything but plain files', async () => {
    const changed = { ...served('1.0.2', FILES), bundle: await digestOf({ ...FILES, 'chunk-a.js': 'b\n' }) }
    const error = await fetchGemini({ pin: changed, root: path.join(scratch, 'sha256'), discard }).catch(
      (e: unknown) => e,
    )
    expect(error).toBeInstanceOf(InstallError)
    expect(error).toMatchObject({ reason: 'checksum', message: 'The bundle in the tarball fails its pinned sha256' })
    const linked = { ...served('1.0.3', FILES, 'link.js'), bundle: await digestOf(FILES) }
    await expect(fetchGemini({ pin: linked, root: path.join(scratch, 'link'), discard })).rejects.toMatchObject({
      reason: 'checksum',
    })
    expect(fs.existsSync(versionDir(path.join(scratch, 'link'), '1.0.3'))).toBe(false)
  })

  it('no longer holds a bundle whose file changed on disk', async () => {
    const root = path.join(scratch, 'changed')
    const pin = { ...served('1.0.4', FILES), bundle: await digestOf(FILES) }
    const { entry } = await fetchGemini({ pin, root, discard })
    expect(await holdsBundle(root, pin)).toBe(true)
    fs.chmodSync(entry, 0o600)
    fs.writeFileSync(entry, 'console.log("changed")\n')
    expect(await holdsBundle(root, pin)).toBe(false)
  })
})
