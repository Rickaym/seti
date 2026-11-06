import { makeZip } from './fixtures.js'

const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
const OOXML_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const PACKAGE_REL = 'http://schemas.openxmlformats.org/package/2006/relationships'

const relationships = (rels: readonly [string, string][]) =>
  `${XML}<Relationships xmlns="${PACKAGE_REL}">${rels
    .map(
      ([type, target], n) => `<Relationship Id="rId${String(n + 1)}" Type="${OOXML_REL}/${type}" Target="${target}"/>`,
    )
    .join('')}</Relationships>`

const contentTypes = (overrides: readonly [string, string][]) =>
  [
    `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`,
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
    '<Default Extension="xml" ContentType="application/xml"/>',
    ...overrides.map(([part, type]) => `<Override PartName="${part}" ContentType="${type}"/>`),
    '</Types>',
  ].join('')

const entry = (name: string, text: string) => ({ name, data: Buffer.from(text, 'utf8') })

const WORD_MAIN = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml'
const SHEET_MAIN = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml'
const WORKSHEET = 'application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml'
const SPREADSHEET_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'

/** A Word document of plain paragraphs, the least a .docx can be. */
export function makeDocx(paragraphs: readonly string[]): Buffer {
  const body = paragraphs.map((text) => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`).join('')
  const document = `${XML}<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`
  return makeZip([
    entry('[Content_Types].xml', contentTypes([['/word/document.xml', WORD_MAIN]])),
    entry('_rels/.rels', relationships([['officeDocument', 'word/document.xml']])),
    entry('word/document.xml', document),
  ])
}

/** A workbook of one sheet holding the rows, text as inline strings. */
export function makeXlsx(rows: readonly (readonly string[])[]): Buffer {
  const cell = (text: string) => `<c t="inlineStr"><is><t>${text}</t></is></c>`
  const data = rows.map((row, r) => `<row r="${String(r + 1)}">${row.map(cell).join('')}</row>`).join('')
  const workbook = `${XML}<workbook xmlns="${SPREADSHEET_NS}" xmlns:r="${OOXML_REL}"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>`
  return makeZip([
    entry(
      '[Content_Types].xml',
      contentTypes([
        ['/xl/workbook.xml', SHEET_MAIN],
        ['/xl/worksheets/sheet1.xml', WORKSHEET],
      ]),
    ),
    entry('_rels/.rels', relationships([['officeDocument', 'xl/workbook.xml']])),
    entry('xl/workbook.xml', workbook),
    entry('xl/_rels/workbook.xml.rels', relationships([['worksheet', 'worksheets/sheet1.xml']])),
    entry(
      'xl/worksheets/sheet1.xml',
      `${XML}<worksheet xmlns="${SPREADSHEET_NS}"><sheetData>${data}</sheetData></worksheet>`,
    ),
  ])
}

const ODF_NAMESPACES = [
  'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"',
  'xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"',
  'xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0"',
  'xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0"',
  'xmlns:script="urn:oasis:names:tc:opendocument:xmlns:script:1.0"',
  'xmlns:xlink="http://www.w3.org/1999/xlink"',
].join(' ')

interface OdfOptions {
  /** Office content before the body, such as event listeners in office:scripts. */
  head?: string
  /** Files beside content.xml, such as a Basic library. */
  extra?: readonly { name: string; data: Buffer }[]
}

/** An OpenDocument text or presentation with the given body, built the way LibreOffice reads it. */
export function makeOdf(type: 'text' | 'presentation', body: string, options: OdfOptions = {}): Buffer {
  const mime = `application/vnd.oasis.opendocument.${type}`
  const extra = options.extra ?? []
  const files = ['content.xml', ...extra.map((file) => file.name)]
  const manifest = [
    `${XML}<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.2">`,
    `<manifest:file-entry manifest:full-path="/" manifest:media-type="${mime}"/>`,
    ...files.map((file) => `<manifest:file-entry manifest:full-path="${file}" manifest:media-type="text/xml"/>`),
    '</manifest:manifest>',
  ].join('')
  const content =
    `${XML}<office:document-content ${ODF_NAMESPACES} office:version="1.2">${options.head ?? ''}` +
    `<office:body><office:${type}>${body}</office:${type}></office:body></office:document-content>`
  return makeZip([
    entry('mimetype', mime),
    entry('content.xml', content),
    ...extra,
    entry('META-INF/manifest.xml', manifest),
  ])
}

const BASIC_HEAD = '<?xml version="1.0" encoding="UTF-8"?>\n'

/** A text document whose Basic macro runs on open, if anything lets it, and writes into the text. */
export function makeMacroOdt(marker: string): Buffer {
  const listener =
    '<office:scripts><office:event-listeners><script:event-listener script:language="ooo:script" ' +
    'script:event-name="dom:load" xlink:href="vnd.sun.star.script:Standard.Module1.Boom?language=Basic&amp;location=document"/>' +
    '</office:event-listeners></office:scripts>'
  const module =
    `${BASIC_HEAD}<script:module xmlns:script="http://openoffice.org/2000/script" script:name="Module1" script:language="StarBasic">` +
    `Sub Boom\n  ThisComponent.Text.insertString(ThisComponent.Text.getEnd(), "${marker}", False)\n` +
    '  Shell("/bin/sh -c \'touch /out/macro-ran\'")\nEnd Sub\n</script:module>'
  const library =
    `${BASIC_HEAD}<library:library xmlns:library="http://openoffice.org/2000/library" library:name="Standard" ` +
    'library:readonly="false" library:passwordprotected="false"><library:element library:name="Module1"/></library:library>'
  const libraries =
    `${BASIC_HEAD}<library:libraries xmlns:library="http://openoffice.org/2000/library" xmlns:xlink="http://www.w3.org/1999/xlink">` +
    '<library:library library:name="Standard" library:link="false"/></library:libraries>'
  return makeOdf('text', '<text:p>Macro fixture</text:p>', {
    head: listener,
    extra: [
      entry('Basic/script-lc.xml', libraries),
      entry('Basic/Standard/script-lb.xml', library),
      entry('Basic/Standard/Module1.xml', module),
    ],
  })
}
