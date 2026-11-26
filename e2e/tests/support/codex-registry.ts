import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import { gzipSync } from 'node:zlib'
import { paths } from './env.js'

const MEMBER = 'package/vendor/e2e/bin/codex'
const HOST_MEMBER = 'package/vendor/e2e/bin/codex-code-mode-host'

/** The Codex version this Seti needs, which the registry's stand-in and the Ready one report. */
export const PINNED_CODEX = (
  JSON.parse(
    fs.readFileSync(path.join(import.meta.dirname, '../../../server/src/runtimes/codex/pin.json'), 'utf8'),
  ) as { version: string }
).version

/** How the registry answers: serve the tarball, hold it until released, corrupt it, or refuse. */
export type RegistryMode = 'serve' | 'hold' | 'corrupt' | 'down'

/**
 * A stand-in for the npm registry that serves a Codex tarball whose program only answers
 * `--version`, so turning Codex on installs something without the network or a real Codex.
 */
export class CodexRegistry {
  mode: RegistryMode = 'serve'
  /** How many tarballs Seti asked for. */
  asked = 0
  private readonly held: (() => void)[] = []
  private readonly server = http.createServer((_req, res) => {
    this.answer(res)
  })

  private readonly tarball: Buffer

  constructor(tarball: Buffer) {
    this.tarball = tarball
  }

  /** Lets every held download go on, and serves the next ones straight away. */
  release(): void {
    this.mode = 'serve'
    for (const go of this.held.splice(0)) {
      go()
    }
  }

  async listen(): Promise<number> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve))
    return (this.server.address() as AddressInfo).port
  }

  async close(): Promise<void> {
    this.release()
    this.server.closeAllConnections()
    await new Promise<void>((resolve) =>
      this.server.close(() => {
        resolve()
      }),
    )
  }

  private answer(res: http.ServerResponse): void {
    this.asked += 1
    if (this.mode === 'down') {
      res.writeHead(503).end()
      return
    }
    const bytes = this.mode === 'corrupt' ? Buffer.concat([this.tarball, Buffer.from('changed')]) : this.tarball
    const send = () => res.writeHead(200, { 'content-length': String(bytes.length) }).end(bytes)
    if (this.mode === 'hold') {
      this.held.push(send)
      return
    }
    send()
  }
}

let current: CodexRegistry | null = null

/** This worker's registry, which its Seti installs Codex from. */
export function codexRegistry(): CodexRegistry {
  if (current === null) {
    throw new Error("This worker's Seti runs without the Codex registry")
  }
  return current
}

/** Packs the stand-in program and code mode host as the npm package does, with their checksums. */
function standInTarball(dir: string) {
  const binary = path.join(dir, MEMBER)
  fs.mkdirSync(path.dirname(binary), { recursive: true })
  fs.writeFileSync(binary, `#!/bin/sh\necho "codex-cli ${PINNED_CODEX}"\n`, { mode: 0o700 })
  const host = path.join(dir, HOST_MEMBER)
  fs.writeFileSync(host, '#!/bin/sh\nexit 1\n', { mode: 0o700 })
  const tar = path.join(dir, 'codex.tar')
  execFileSync('/usr/bin/tar', ['-cf', tar, '-C', dir, 'package'])
  const tarball = gzipSync(fs.readFileSync(tar))
  return {
    tarball,
    integrity: `sha512-${createHash('sha512').update(tarball).digest('base64')}`,
    sha256: createHash('sha256').update(fs.readFileSync(binary)).digest('hex'),
    hostSha256: createHash('sha256').update(fs.readFileSync(host)).digest('hex'),
  }
}

/**
 * Starts this worker's registry and writes the pin its Seti installs from; returns the variable
 * that points Seti at that pin.
 */
export async function startCodexRegistry(): Promise<NodeJS.ProcessEnv> {
  const dir = path.join(paths.root, 'codex-registry')
  fs.mkdirSync(dir, { recursive: true })
  const { tarball, integrity, sha256, hostSha256 } = standInTarball(dir)
  current = new CodexRegistry(tarball)
  const port = await current.listen()
  const pin = {
    version: PINNED_CODEX,
    platforms: {
      [`${process.platform}-${process.arch}`]: {
        tarball: `http://127.0.0.1:${String(port)}/codex-${PINNED_CODEX}.tgz`,
        integrity,
        binary: MEMBER,
        sha256,
        host: { member: HOST_MEMBER, sha256: hostSha256 },
      },
    },
  }
  const pinFile = path.join(dir, 'pin.json')
  fs.writeFileSync(pinFile, JSON.stringify(pin))
  return { SETI_CODEX_PIN: pinFile }
}

/** Stops this worker's registry. */
export async function stopCodexRegistry(): Promise<void> {
  await current?.close()
  current = null
}
