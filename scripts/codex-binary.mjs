import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'

// Fetches the pinned Codex binary into a folder, checks both checksums, and prints its path.

const PIN = 'server/src/runtimes/codex/pin.json'

/** @param {string} algorithm @param {Buffer} bytes @param {'hex' | 'base64'} encoding */
const digest = (algorithm, bytes, encoding) => createHash(algorithm).update(bytes).digest(encoding)

/** @param {string} message @returns {never} */
function fail(message) {
  process.stderr.write(`${message}\n`)
  process.exit(1)
}

const folder = process.argv[2]
if (folder === undefined) {
  fail('usage: node scripts/codex-binary.mjs <folder>')
}
/** @typedef {{ tarball: string, integrity: string, binary: string, sha256: string }} Platform */
/** @typedef {{ version: string, platforms: Record<string, Platform | undefined> }} Pin */

/** @type {unknown} */
const parsed = JSON.parse(readFileSync(PIN, 'utf8'))
const pin = /** @type {Pin} */ (parsed)
const platform = pin.platforms[`${process.platform}-${process.arch}`]
if (platform === undefined) {
  fail(`Codex ${pin.version} is not pinned for ${process.platform}-${process.arch}`)
}
const home = path.join(folder, pin.version)
const binary = path.join(home, 'codex')
if (!existsSync(binary) || digest('sha256', readFileSync(binary), 'hex') !== platform.sha256) {
  const response = await fetch(platform.tarball)
  if (!response.ok) {
    fail(`The registry answered ${String(response.status)} for ${platform.tarball}`)
  }
  const tarball = Buffer.from(await response.arrayBuffer())
  if (`sha512-${digest('sha512', tarball, 'base64')}` !== platform.integrity) {
    fail(`The tarball at ${platform.tarball} does not match the pinned integrity`)
  }
  mkdirSync(home, { recursive: true })
  const unpacked = spawnSync('tar', ['-xzO', '-f', '-', platform.binary], { input: tarball, maxBuffer: 2 ** 30 })
  if (unpacked.status !== 0 || digest('sha256', unpacked.stdout, 'hex') !== platform.sha256) {
    fail(`The binary in ${platform.tarball} does not match the pinned sha256`)
  }
  const partial = `${binary}.partial`
  writeFileSync(partial, unpacked.stdout)
  chmodSync(partial, 0o755)
  renameSync(partial, binary)
}
process.stdout.write(`${path.resolve(binary)}\n`)
