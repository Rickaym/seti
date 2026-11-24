import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import { gzipSync } from 'node:zlib'
import { findBinary } from './binaries.js'
import type { CodexPin } from './codex-fetch.js'

const MEMBER = 'package/vendor/test/bin/codex'
const PLATFORM = `${process.platform}-${process.arch}`

/** A Codex build a test registry serves: the tarball's bytes and the checksums a pin names. */
export interface FakeBuild {
  version: string
  tarball: Buffer
  integrity: string
  sha256: string
}

/**
 * Packs `program` (a file's path) as the binary of a registry tarball for `version`, the way the
 * npm package lays it out.
 */
export function fakeBuild(scratch: string, version: string, program: string): FakeBuild {
  const dir = fs.mkdtempSync(path.join(scratch, 'build-'))
  const binary = path.join(dir, MEMBER)
  fs.mkdirSync(path.dirname(binary), { recursive: true })
  fs.copyFileSync(program, binary)
  fs.chmodSync(binary, 0o700)
  const tar = path.join(dir, 'codex.tar')
  execFileSync(findBinary('tar'), ['-cf', tar, '-C', dir, 'package'])
  const tarball = gzipSync(fs.readFileSync(tar), { level: 1 })
  fs.rmSync(tar)
  return {
    version,
    tarball,
    integrity: `sha512-${createHash('sha512').update(tarball).digest('base64')}`,
    sha256: createHash('sha256').update(fs.readFileSync(binary)).digest('hex'),
  }
}

/** A script that writes `marker` when it runs and answers `--version` as the codex program does. */
export function markerProgram(scratch: string, version: string, marker: string): string {
  const file = path.join(scratch, `codex-${version}-${String(Date.now())}.sh`)
  fs.writeFileSync(file, `#!/bin/sh\ntouch '${marker}'\necho "codex-cli ${version}"\n`, { mode: 0o755 })
  return file
}

/** How the registry answers the next requests. */
export type RegistryMode = 'serve' | 'cut' | 'down' | 'hold' | 'whole'

/**
 * A registry on this machine that serves fake Codex tarballs: whole, from a range, cut halfway,
 * held until released, or refused, and counts what it was asked.
 */
export class FakeRegistry {
  readonly builds = new Map<string, FakeBuild>()
  readonly ranges: (string | null)[] = []
  mode: RegistryMode = 'serve'
  private readonly held: (() => void)[] = []
  private readonly server = http.createServer((req, res) => {
    this.answer(req, res)
  })

  async start(): Promise<this> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve))
    return this
  }

  get origin(): string {
    return `http://127.0.0.1:${String((this.server.address() as AddressInfo).port)}`
  }

  /** The pin a Seti under test installs `build` from, with its checksums changed when asked. */
  pin(build: FakeBuild, change: { integrity?: string; sha256?: string } = {}): CodexPin {
    this.builds.set(build.version, build)
    return {
      version: build.version,
      platforms: {
        [PLATFORM]: {
          tarball: `${this.origin}/codex-${build.version}.tgz`,
          integrity: change.integrity ?? build.integrity,
          binary: MEMBER,
          sha256: change.sha256 ?? build.sha256,
        },
      },
    }
  }

  /** Lets every held request go on. */
  release(): void {
    for (const go of this.held.splice(0)) {
      go()
    }
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

  private answer(req: http.IncomingMessage, res: http.ServerResponse): void {
    const build = this.builds.get(/codex-([\d.]+)\.tgz$/.exec(req.url ?? '')?.[1] ?? '')
    this.ranges.push(req.headers.range ?? null)
    if (build === undefined || this.mode === 'down') {
      res.writeHead(503).end()
      return
    }
    if (this.mode === 'hold') {
      this.held.push(() => {
        this.send(build.tarball, req, res)
      })
      return
    }
    if (this.mode === 'cut') {
      res.writeHead(200, { 'content-length': String(build.tarball.length) })
      res.write(build.tarball.subarray(0, Math.floor(build.tarball.length / 2)), () => req.socket.end())
      return
    }
    this.send(build.tarball, req, res)
  }

  private send(bytes: Buffer, req: http.IncomingMessage, res: http.ServerResponse): void {
    const from = Number(/^bytes=(\d+)-$/.exec(req.headers.range ?? '')?.[1] ?? '0')
    if (this.mode === 'whole' || from === 0) {
      res.writeHead(200, { 'content-length': String(bytes.length) }).end(bytes)
      return
    }
    const rest = bytes.subarray(from)
    res.writeHead(206, { 'content-length': String(rest.length) }).end(rest)
  }
}
