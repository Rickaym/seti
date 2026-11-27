import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { gzipSync } from 'node:zlib'
import { CodexRegistry } from './codex-registry.js'
import { paths } from './env.js'

/** The Gemini CLI version Seti pins, which the stand-in tarball claims to be. */
export const PINNED_GEMINI = (
  JSON.parse(
    fs.readFileSync(path.join(import.meta.dirname, '../../../server/src/runtimes/gemini/pin.json'), 'utf8'),
  ) as { version: string }
).version

const sha256 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex')

/** Packs a bundle whose script does nothing, with the sha512 and folder digest a pin names. */
function standInTarball(dir: string) {
  const bundle = path.join(dir, 'package', 'bundle')
  fs.mkdirSync(bundle, { recursive: true })
  const script = 'process.exit(1)\n'
  fs.writeFileSync(path.join(bundle, 'gemini.js'), script)
  const tar = path.join(dir, 'gemini.tar')
  execFileSync('/usr/bin/tar', ['-cf', tar, '-C', dir, 'package'])
  const tarball = gzipSync(fs.readFileSync(tar))
  return {
    tarball,
    integrity: `sha512-${createHash('sha512').update(tarball).digest('base64')}`,
    bundle: sha256(`gemini.js\0${sha256(script)}\n`),
  }
}

let current: CodexRegistry | null = null

/** This worker's Gemini registry, which its Seti installs Gemini CLI from. */
export function geminiRegistry(): CodexRegistry {
  if (current === null) {
    throw new Error("This worker's Seti runs without the Gemini registry")
  }
  return current
}

/** Starts this worker's Gemini registry and writes the pin Seti installs from. */
export async function startGeminiRegistry(): Promise<NodeJS.ProcessEnv> {
  const dir = path.join(paths.root, 'gemini-registry')
  fs.mkdirSync(dir, { recursive: true })
  const { tarball, integrity, bundle } = standInTarball(dir)
  current = new CodexRegistry(tarball)
  const port = await current.listen()
  const pin = {
    version: PINNED_GEMINI,
    tarball: `http://127.0.0.1:${String(port)}/gemini-cli-${PINNED_GEMINI}.tgz`,
    integrity,
    bundle,
  }
  const pinFile = path.join(dir, 'pin.json')
  fs.writeFileSync(pinFile, JSON.stringify(pin))
  return { SETI_GEMINI_PIN: pinFile }
}

/** Stops this worker's Gemini registry. */
export async function stopGeminiRegistry(): Promise<void> {
  await current?.close()
  current = null
}
