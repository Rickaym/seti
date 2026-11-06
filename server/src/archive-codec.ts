import { createHash } from 'node:crypto'
import { promisify } from 'node:util'
import zlib from 'node:zlib'

/** A transcript row exactly as task_message stores it, its payload still JSON text. */
export interface StoredMessage {
  id: number
  kind: string
  payload: string
  outward: string
  created_at: string
}

/** Where one independently compressed run of rows sits in the archive blob. */
export interface ChunkRef {
  first_id: number
  last_id: number
  rows: number
  offset: number
  length: number
}

export type ArchiveCodec = 'zstd' | 'gzip'

const ARCHIVE_CODEC: ArchiveCodec = 'zstd'

/** Rows per chunk; a page of the archived transcript decompresses one or two chunks. */
const CHUNK_ROWS = 500
const CHUNK_BYTES = 4 * 1024 * 1024
const ZSTD_LEVEL = 6

const zstdCompress = promisify(zlib.zstdCompress)
const zstdDecompress = promisify(zlib.zstdDecompress)
const gzip = promisify(zlib.gzip)
const gunzip = promisify(zlib.gunzip)

async function compress(codec: ArchiveCodec, data: Buffer): Promise<Buffer> {
  if (codec === 'gzip') {
    return gzip(data, { level: 6 })
  }
  return zstdCompress(data, { params: { [zlib.constants.ZSTD_c_compressionLevel]: ZSTD_LEVEL } })
}

async function decompress(codec: string, data: Buffer): Promise<Buffer> {
  if (codec === 'gzip') {
    return gunzip(data)
  }
  if (codec === 'zstd') {
    return zstdDecompress(data)
  }
  throw new Error(`Unknown archive codec ${codec}`)
}

const bytesOf = (text: string) => Buffer.byteLength(text, 'utf8')

/** The bytes a row takes as stored text: its id, kind, payload, outward list and time. */
const rowBytes = (row: StoredMessage) =>
  8 + bytesOf(row.kind) + bytesOf(row.payload) + bytesOf(row.outward) + bytesOf(row.created_at)

const SAFE_FIELD = /^[^\t\n]*$/

/** Each row is a header line `id kind created_at payload-bytes outward-bytes`, then both texts. */
function encodeRows(rows: readonly StoredMessage[]): Buffer {
  const parts: Buffer[] = []
  for (const row of rows) {
    if (!SAFE_FIELD.test(row.kind) || !SAFE_FIELD.test(row.created_at)) {
      throw new Error(`Message ${String(row.id)} has a kind or time that cannot be archived`)
    }
    const payload = Buffer.from(row.payload, 'utf8')
    const outward = Buffer.from(row.outward, 'utf8')
    const header = [row.id, row.kind, row.created_at, payload.length, outward.length].join('\t')
    parts.push(Buffer.from(`${header}\n`, 'utf8'), payload, outward)
  }
  return Buffer.concat(parts)
}

const NEWLINE = 0x0a

function decodeRows(data: Buffer): StoredMessage[] {
  const rows: StoredMessage[] = []
  let at = 0
  while (at < data.length) {
    const end = data.indexOf(NEWLINE, at)
    if (end < 0) {
      throw new Error('Archive chunk is truncated')
    }
    const [id, kind, createdAt, payloadLength, outwardLength] = data.toString('utf8', at, end).split('\t')
    const payloadEnd = end + 1 + Number(payloadLength)
    const outwardEnd = payloadEnd + Number(outwardLength)
    if (kind === undefined || createdAt === undefined || outwardEnd > data.length) {
      throw new Error('Archive chunk is malformed')
    }
    rows.push({
      id: Number(id),
      kind,
      payload: data.toString('utf8', end + 1, payloadEnd),
      outward: data.toString('utf8', payloadEnd, outwardEnd),
      created_at: createdAt,
    })
    at = outwardEnd
  }
  return rows
}

export interface EncodedArchive {
  codec: ArchiveCodec
  blob: Buffer
  chunks: ChunkRef[]
  sha256: string
  rows: number
  raw_bytes: number
}

/** Collects rows in id order into compressed chunks; the checksum covers every row's bytes. */
export class ArchiveWriter {
  private readonly codec: ArchiveCodec
  private readonly hash = createHash('sha256')
  private readonly parts: Buffer[] = []
  private readonly chunks: ChunkRef[] = []
  private pending: StoredMessage[] = []
  private pendingBytes = 0
  private offset = 0
  private rows = 0
  private rawBytes = 0
  private lastId = 0

  constructor(codec: ArchiveCodec = ARCHIVE_CODEC) {
    this.codec = codec
  }

  async add(rows: readonly StoredMessage[]): Promise<void> {
    for (const row of rows) {
      if (row.id <= this.lastId) {
        throw new Error('Archive rows must come in ascending id order')
      }
      this.lastId = row.id
      this.pending.push(row)
      this.pendingBytes += rowBytes(row)
      this.rawBytes += rowBytes(row)
      if (this.pending.length >= CHUNK_ROWS || this.pendingBytes >= CHUNK_BYTES) {
        await this.flush()
      }
    }
  }

  private async flush(): Promise<void> {
    const [first] = this.pending
    const last = this.pending.at(-1)
    if (first === undefined || last === undefined) {
      return
    }
    const plain = encodeRows(this.pending)
    this.hash.update(plain)
    const packed = await compress(this.codec, plain)
    this.parts.push(packed)
    this.chunks.push({
      first_id: first.id,
      last_id: last.id,
      rows: this.pending.length,
      offset: this.offset,
      length: packed.length,
    })
    this.offset += packed.length
    this.rows += this.pending.length
    this.pending = []
    this.pendingBytes = 0
  }

  async finish(): Promise<EncodedArchive> {
    await this.flush()
    return {
      codec: this.codec,
      blob: Buffer.concat(this.parts),
      chunks: this.chunks,
      sha256: this.hash.digest('hex'),
      rows: this.rows,
      raw_bytes: this.rawBytes,
    }
  }
}

export async function decodeChunk(codec: string, bytes: Buffer): Promise<StoredMessage[]> {
  return decodeRows(await decompress(codec, bytes))
}

/** Every row of an archive in id order; throws unless the rows match the stored checksum. */
export async function decodeArchive(
  archive: Pick<EncodedArchive, 'blob' | 'chunks' | 'sha256'> & { codec: string },
): Promise<StoredMessage[]> {
  const hash = createHash('sha256')
  const rows: StoredMessage[] = []
  for (const chunk of archive.chunks) {
    const plain = await decompress(archive.codec, archive.blob.subarray(chunk.offset, chunk.offset + chunk.length))
    hash.update(plain)
    const decoded = decodeRows(plain)
    if (decoded.length !== chunk.rows) {
      throw new Error('Archive chunk holds a different number of rows than its index says')
    }
    rows.push(...decoded)
  }
  if (hash.digest('hex') !== archive.sha256) {
    throw new Error('Archive checksum does not match; the transcript was not restored')
  }
  return rows
}
