import { createHash } from 'node:crypto'

const HEADER = 'seti-mod-package-v1\n'

const hex = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')

/** The package's content hash: each file's path and SHA-256, sorted bytewise by path. */
export function packageHash(files: ReadonlyMap<string, Buffer>): string {
  const paths = [...files.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
  const hash = createHash('sha256').update(HEADER)
  for (const path of paths) {
    const bytes = files.get(path) ?? Buffer.alloc(0)
    hash.update(`${path}\0${hex(bytes)}\n`)
  }
  return hash.digest('hex')
}
