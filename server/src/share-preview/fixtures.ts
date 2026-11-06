import zlib from 'node:zlib'

interface PdfOptions {
  title?: string
  /** Extra entries of the document catalog, such as an OpenAction. */
  catalog?: string
  /** Extra objects, numbered after the built-in ones, for the catalog to point at. */
  objects?: string[]
  /** Lines of text a page; 0 gives every page one shared, empty content stream. */
  lines?: number
  /** Turns every page by this many degrees, as a landscape scan often is. */
  rotate?: number
}

/** A small valid PDF with text pages in Helvetica, built in memory for tests. */
export function makePdf(pages: number, options: PdfOptions = {}): Buffer {
  const objects: string[] = []
  const add = (body: string) => objects.push(body)
  add('')
  add('')
  add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
  add(`<< /Title (${options.title ?? 'Fixture'}) >>`)
  for (const object of options.objects ?? []) {
    add(object)
  }
  const lines = options.lines ?? 20
  const shared = lines === 0 ? add('<< /Length 0 >>\nstream\n\nendstream') : 0
  const kids: number[] = []
  for (let page = 1; page <= pages; page += 1) {
    let content = shared
    if (lines > 0) {
      let text = `BT /F1 24 Tf 72 720 Td (Page ${String(page)} heading) Tj ET\n`
      for (let line = 0; line < lines; line += 1) {
        text += `BT /F1 11 Tf 72 ${String(690 - line * 20)} Td (Line ${String(line)} of page ${String(page)}) Tj ET\n`
      }
      content = add(`<< /Length ${String(Buffer.byteLength(text))} >>\nstream\n${text}endstream`)
    }
    const resources = `/Rotate ${String(options.rotate ?? 0)} /Resources << /Font << /F1 3 0 R >> >>`
    kids.push(
      add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ${resources} /Contents ${String(content)} 0 R >>`),
    )
  }
  objects[0] = `<< /Type /Catalog /Pages 2 0 R ${options.catalog ?? ''} >>`
  const refs = kids.map((kid) => `${String(kid)} 0 R`).join(' ')
  objects[1] = `<< /Type /Pages /Kids [${refs}] /Count ${String(kids.length)} >>`
  let out = '%PDF-1.4\n'
  const offsets: number[] = []
  for (const [n, body] of objects.entries()) {
    offsets.push(Buffer.byteLength(out, 'latin1'))
    out += `${String(n + 1)} 0 obj\n${body}\nendobj\n`
  }
  const xref = Buffer.byteLength(out, 'latin1')
  out += `xref\n0 ${String(objects.length + 1)}\n0000000000 65535 f \n`
  out += offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')
  out += `trailer\n<< /Size ${String(objects.length + 1)} /Root 1 0 R /Info 4 0 R >>\nstartxref\n${String(xref)}\n%%EOF\n`
  return Buffer.from(out, 'latin1')
}

/** A PNG of one colour, made without an image library. */
export function makePng(width: number, height: number): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) === 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    return c >>> 0
  })
  const crc = (bytes: Buffer) => {
    let c = 0xffffffff
    for (const byte of bytes) {
      c = (crcTable[(c ^ byte) & 0xff] ?? 0) ^ (c >>> 8)
    }
    return (c ^ 0xffffffff) >>> 0
  }
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(8)
    head.writeUInt32BE(data.length, 0)
    head.write(type, 4, 'latin1')
    const tail = Buffer.alloc(4)
    tail.writeUInt32BE(crc(Buffer.concat([head.subarray(4), data])), 0)
    return Buffer.concat([head, data, tail])
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header.set([8, 2, 0, 0, 0], 8)
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, 0x80)])
  const pixels = zlib.deflateSync(Buffer.concat(Array.from({ length: height }, () => row)))
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  return Buffer.concat([signature, chunk('IHDR', header), chunk('IDAT', pixels), chunk('IEND', Buffer.alloc(0))])
}

interface ZipEntry {
  name: string
  data: Buffer
  /** A size the central directory declares instead of the real one. */
  declared?: number
}

/** A zip of stored entries, its central directory free to lie about sizes. */
export function makeZip(entries: readonly ZipEntry[]): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8')
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(0x800, 6)
    local.writeUInt32LE(entry.data.length, 18)
    local.writeUInt32LE(entry.data.length, 22)
    local.writeUInt16LE(name.length, 26)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(0x800, 8)
    central.writeUInt16LE(0x5a21, 12)
    central.writeUInt16LE(0x5b5c, 14)
    central.writeUInt32LE(entry.data.length, 20)
    central.writeUInt32LE(entry.declared ?? entry.data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(offset, 42)
    locals.push(local, name, entry.data)
    centrals.push(central, name)
    offset += 30 + name.length + entry.data.length
  }
  const directory = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, directory, end])
}

/** A ustar archive of the entries, each with a valid header checksum. */
export function makeTar(entries: readonly { name: string; data: Buffer }[]): Buffer {
  const blocks: Buffer[] = []
  for (const entry of entries) {
    const header = Buffer.alloc(512)
    header.write(entry.name.slice(0, 100), 0, 'utf8')
    header.write('0000644\0', 100, 'latin1')
    header.write(`${entry.data.length.toString(8).padStart(11, '0')}\0`, 124, 'latin1')
    header.write(`${(1_700_000_000).toString(8).padStart(11, '0')}\0`, 136, 'latin1')
    header.write('        ', 148, 'latin1')
    header.write('0', 156, 'latin1')
    header.write('ustar\u000000', 257, 'latin1')
    const sum = header.reduce((total, byte) => total + byte, 0)
    header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'latin1')
    blocks.push(header, entry.data, Buffer.alloc((512 - (entry.data.length % 512)) % 512))
  }
  return Buffer.concat([...blocks, Buffer.alloc(1024)])
}
