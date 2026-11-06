import fs from 'node:fs'
import path from 'node:path'

const PNG = fs.readFileSync(path.join(import.meta.dirname, 'media', 'dot.png'))

/** A small valid PDF of text pages in Helvetica, built in memory rather than committed. */
export function makePdf(pages: number, title: string): Buffer {
  const objects = ['', '', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Title (${title}) >>`]
  const kids: number[] = []
  for (let page = 1; page <= pages; page += 1) {
    let text = `BT /F1 24 Tf 72 720 Td (Page ${String(page)} heading) Tj ET\n`
    for (let line = 0; line < 20; line += 1) {
      text += `BT /F1 11 Tf 72 ${String(690 - line * 20)} Td (Line ${String(line)} of page ${String(page)}) Tj ET\n`
    }
    objects.push(`<< /Length ${String(Buffer.byteLength(text))} >>\nstream\n${text}endstream`)
    const content = objects.length
    const resources = '/Resources << /Font << /F1 3 0 R >> >>'
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ${resources} /Contents ${String(content)} 0 R >>`,
    )
    kids.push(objects.length)
  }
  objects[0] = '<< /Type /Catalog /Pages 2 0 R /OpenAction << /S /JavaScript /JS (app.alert\\(1\\)) >> >>'
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

/** A wide table: 1,500 rows of 12 columns, with cells that try formulas and markup. */
export function makeCsv(): string {
  const header = Array.from({ length: 12 }, (_, n) => `column_${String(n)}_with_a_long_name`).join(',')
  const cell = (row: number, n: number) => (n === 0 ? `=SUM(A${String(row)})` : `<b>${String(row * n)}</b>`)
  const rows = Array.from({ length: 1500 }, (_, row) => Array.from({ length: 12 }, (__, n) => cell(row, n)).join(','))
  return [header, ...rows].join('\n')
}

/** A notebook with a Markdown cell, a code cell, text and HTML outputs and one image. */
export function makeNotebook(): string {
  return JSON.stringify({
    nbformat: 4,
    nbformat_minor: 5,
    metadata: { language_info: { name: 'python' } },
    cells: [
      { cell_type: 'markdown', metadata: {}, source: ['# Analysis\n', 'Numbers from **Q3**.'] },
      {
        cell_type: 'code',
        execution_count: 1,
        metadata: {},
        source: ['total = sum(range(10))\n', 'print(total)'],
        outputs: [
          { output_type: 'stream', name: 'stdout', text: ['45\n'] },
          {
            output_type: 'display_data',
            metadata: {},
            data: { 'text/html': ['<script>document.title="ran"</script>'] },
          },
          { output_type: 'display_data', metadata: {}, data: { 'image/png': PNG.toString('base64') } },
        ],
      },
    ],
  })
}

export const SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="60"><script>document.title="ran"</script>' +
  '<rect width="120" height="60" fill="#0969da"/><image href="https://example.com/x.png" width="10" height="10"/></svg>\n'
