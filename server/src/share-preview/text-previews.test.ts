import zlib from 'node:zlib'
import { HIGHLIGHT_LINE_MAX } from '@seti/shared'
import { describe, expect, it } from 'vitest'
import { zipListing } from './archive.js'
import { HIGHLIGHT_MAX, LINES_MAX } from './code.js'
import { makePng, makeTar, makeZip } from './fixtures.js'
import { fillImages, type PreviewInput } from './preview.js'
import { renderPreview } from './render.js'
import { parseTable } from './table.js'

const TEXT = 'text/plain; charset=utf-8'

const render = async (name: string, content: string | Buffer, kind: PreviewInput['kind'] = 'text', mime = TEXT) =>
  renderPreview({ name, kind, mime, content: Buffer.from(content), images: new Map() })

const LIVE = /<script|<iframe|<object|<embed|<svg|<style|<form|<input|\son\w+="|="javascript:/i

describe('tables', () => {
  it('parses quoted fields with delimiters, quotes and line breaks', () => {
    const parsed = parseTable('a,b\n"x, y","say ""hi""\nthere"\n', ',')
    expect(parsed.rows).toEqual([
      ['a', 'b'],
      ['x, y', 'say "hi"\nthere'],
    ])
    expect(parsed.records).toBe(2)
  })

  it('escapes formula and HTML cells, and counts rows and columns', async () => {
    const csv =
      'name,cmd\n<script>alert(1)</script>,"=HYPERLINK(""http://evil"",""x"")"\n"<img src=x onerror=alert(1)>",+cmd|calc\n'
    const preview = await render('data.csv', csv, 'csv')
    expect(preview.label).toBe('Table, 2 rows, 2 columns')
    expect(preview.body).not.toMatch(LIVE)
    expect(preview.body).toContain('<td>&lt;script&gt;alert(1)&lt;/script&gt;</td>')
    expect(preview.body).toContain('<td>=HYPERLINK(&quot;http://evil&quot;,&quot;x&quot;)</td>')
    expect(preview.body).toContain('<th>name</th><th>cmd</th>')
  })

  it('shows the first 1,000 rows and 50 columns and says so', async () => {
    const header = Array.from({ length: 60 }, (_, n) => `c${String(n)}`).join(',')
    const row = Array.from({ length: 60 }, (_, n) => String(n)).join(',')
    const csv = [header, ...Array.from({ length: 3400 }, () => row)].join('\n')
    const preview = await render('wide.csv', csv, 'csv')
    expect(preview.label).toBe('Table, 3,400 rows, 60 columns')
    expect(preview.note).toBe('first 1,000 rows shown, first 50 columns shown')
    expect(preview.body.match(/<tr>/g)).toHaveLength(1001)
    expect(preview.body).toContain('<th>c49</th></tr>')
  })

  it('reads a TSV by its name', async () => {
    const preview = await render('a.tsv', 'x\ty\n1\t2\n', 'csv')
    expect(preview.body).toContain('<td>1</td><td>2</td>')
  })
})

describe('data files', () => {
  it('indents and highlights JSON', async () => {
    const preview = await render('a.json', '{"a":[1,true,"<b>"]}')
    expect(preview.label).toBe('JSON')
    expect(preview.body).toContain('class="tok-string"')
    expect(preview.body).toContain('&lt;b&gt;')
    expect(preview.body.match(/class="l"/g)).toHaveLength(7)
  })

  it('shows invalid JSON as plain text and says why', async () => {
    const preview = await render('a.json', '{"a": <script>}')
    expect(preview.note).toBe('not valid JSON, shown as text')
    expect(preview.body).not.toContain('tok-')
    expect(preview.body).not.toMatch(LIVE)
  })

  it('counts JSON Lines records and highlights YAML and TOML', async () => {
    expect((await render('a.jsonl', '{"a":1}\n{"a":2}\n\n')).label).toBe('JSON Lines, 2 records')
    expect((await render('a.yaml', 'name: "x"\n')).body).toContain('tok-string')
    expect((await render('a.toml', 'name = "x"\n')).body).toContain('tok-string')
  })
})

describe('code and text', () => {
  it('highlights code with numbered lines and escapes it', async () => {
    const preview = await render('app.ts', 'const a = "</pre><script>x</script>"\nexport { a }\n')
    expect(preview.label).toBe('TypeScript code, 2 lines')
    expect(preview.body).toContain('<span class="tok-keyword">const</span>')
    expect(preview.body).not.toMatch(LIVE)
    expect(preview.body.match(/class="l"/g)).toHaveLength(2)
    expect(preview.body).toContain('<pre class="code" ')
  })

  it('leaves code over the highlight cap plain', async () => {
    const big = 'const a = 1\n'.repeat(Math.ceil(HIGHLIGHT_MAX / 12) + 10)
    const preview = await render('big.js', big)
    expect(preview.body).not.toContain('tok-')
  })

  it('leaves code with a line past the line cap plain', async () => {
    const long = `<p>top</p>\n<script>const a = [${'1,'.repeat(HIGHLIGHT_LINE_MAX / 2)}]</script>\n`
    expect((await render('page.html', long)).body).not.toContain('tok-')
    expect((await render('page.html', '<p>top</p>\n')).body).toContain('tok-')
  })

  it('wraps plain text and logs, and caps the lines it shows', async () => {
    const log = Array.from({ length: LINES_MAX + 5 }, (_, n) => `line ${String(n)}`).join('\n')
    const preview = await render('server.log', log)
    expect(preview.label).toBe('Text, 20,005 lines')
    expect(preview.note).toBe('first 20,000 of 20,005 lines shown')
    expect(preview.body).toContain('<pre class="code wrap" ')
  })
})

describe('notebooks', () => {
  const PNG = makePng(8, 8).toString('base64')
  const notebook = {
    metadata: { language_info: { name: 'python' } },
    cells: [
      { cell_type: 'markdown', source: ['# Title\n', '<script>alert(1)</script> [x](javascript:alert(1))'] },
      {
        cell_type: 'code',
        execution_count: 3,
        source: 'print("hi")',
        outputs: [
          { output_type: 'stream', name: 'stdout', text: ['hi\n', '<b>bold</b>'] },
          {
            output_type: 'display_data',
            data: { 'text/html': '<script>alert(2)</script><img src=x onerror=alert(3)>' },
          },
          { output_type: 'display_data', data: { 'application/javascript': 'alert(4)' } },
          { output_type: 'display_data', data: { 'image/png': PNG, 'text/plain': '<Figure>' } },
          {
            output_type: 'display_data',
            data: { 'image/png': Buffer.from('<svg onload=alert(5)>').toString('base64') },
          },
          {
            output_type: 'error',
            ename: 'ValueError',
            evalue: 'bad',
            traceback: ['\u001b[31mValueError\u001b[0m: bad'],
          },
        ],
      },
    ],
  }

  it('shows cells in order with outputs as text and images, nothing live', async () => {
    const preview = await render('n.ipynb', JSON.stringify(notebook))
    expect(preview.label).toBe('Notebook, 2 cells')
    const body = fillImages(preview.body, preview.imageKey, 'TOKEN')
    expect(body).not.toMatch(LIVE)
    expect(body).toContain('<h1>Title</h1>')
    expect(body).toContain('&lt;script&gt;alert(2)&lt;/script&gt;')
    expect(body).toContain('text/html output, shown as text')
    expect(body).toContain('application/javascript output, shown as text')
    expect(body).toContain('src="TOKEN/p/1"')
    expect(preview.images).toHaveLength(1)
    expect(body).toContain('image/png output, shown as text')
    expect(body).toContain('ValueError: bad')
    expect(body).not.toContain('\u001b')
    expect(body).toContain('[3]')
  })

  it('falls back to the JSON text for a file that is not a notebook', async () => {
    const preview = await render('n.ipynb', '{"not": "cells"}')
    expect(preview.label).toMatch(/^Text/)
  })
})

describe('archives', () => {
  it('lists a zip with path tricks and a huge declared size, escaped and flagged', async () => {
    const zip = makeZip([
      { name: '../../etc/passwd', data: Buffer.from('x') },
      { name: '/abs/<b>.txt', data: Buffer.from('y') },
      { name: 'bomb.bin', data: Buffer.from('z'), declared: 0xfffffff0 },
      { name: 'dir/', data: Buffer.alloc(0) },
    ])
    const preview = await render('a.zip', zip, 'binary', 'application/octet-stream')
    expect(preview.label).toBe('Zip archive, 4 entries')
    expect(preview.body).toContain('../../etc/passwd <span class="flag">unsafe path</span>')
    expect(preview.body).toContain('/abs/&lt;b&gt;.txt <span class="flag">unsafe path</span>')
    expect(preview.body).toContain('4.0 GB')
    expect(preview.body).not.toMatch(LIVE)
  })

  it('stops at 1,000 entries of a zip that declares many more', () => {
    const zip = makeZip(Array.from({ length: 1200 }, (_, n) => ({ name: `f${String(n)}`, data: Buffer.alloc(0) })))
    const listing = zipListing(zip)
    expect(listing?.entries).toHaveLength(1000)
    expect(listing?.total).toBe(1200)
  })

  it('lists a tar and a gzipped tar without unpacking them', async () => {
    const tar = makeTar([
      { name: 'a.txt', data: Buffer.from('hello') },
      { name: '../up.txt', data: Buffer.alloc(700) },
    ])
    const plain = await render('a.tar', tar, 'binary', 'application/octet-stream')
    expect(plain.label).toBe('Tar archive, 2 entries')
    expect(plain.body).toContain('2023-11-14')
    const gz = await render('a.tar.gz', zlib.gzipSync(tar), 'binary', 'application/octet-stream')
    expect(gz.label).toBe('Tar archive, 2 entries')
    expect(gz.body).toContain('unsafe path')
  })

  it('shows no listing for bytes that are not an archive', async () => {
    const preview = await render('a.zip', Buffer.from('not a zip at all'), 'binary', 'application/octet-stream')
    expect(preview.body).toContain('Download it to open it')
  })
})
