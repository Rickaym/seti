import { converterPath, runConverter, type ConverterLimits } from '../converter.js'
import { pdfPreview, type PagedKind } from './pdf.js'
import { capital, converterError, type ImageSlots, type RenderedPreview } from './preview.js'

const MB = 1024 * 1024

const WORD: PagedKind = { name: 'Word document', unit: 'page', subject: 'this document' }
const DOCUMENT: PagedKind = { name: 'Document', unit: 'page', subject: 'this document' }
const SPREADSHEET: PagedKind = { name: 'Spreadsheet', unit: 'page', subject: 'this spreadsheet' }
const SLIDES: PagedKind = { name: 'Slides', unit: 'slide', subject: 'these slides' }

/** Office formats LibreOffice turns into a PDF, by extension, with what each is called. */
export const OFFICE_FORMATS: Readonly<Record<string, PagedKind>> = {
  docx: WORD,
  doc: WORD,
  odt: DOCUMENT,
  rtf: DOCUMENT,
  xlsx: SPREADSHEET,
  xlsm: SPREADSHEET,
  xls: SPREADSHEET,
  ods: SPREADSHEET,
  pptx: SLIDES,
  ppt: SLIDES,
  odp: SLIDES,
}

/** LibreOffice needs more address space than poppler, and a minute for a long document. */
const LIMITS: ConverterLimits = {
  timeoutMs: 60_000,
  cpuSeconds: 60,
  memoryBytes: 1536 * MB,
  fileBytes: 64 * MB,
  outputBytes: 64 * MB,
  tmpBytes: 256 * MB,
}

/** Its configuration links into /etc; nothing else outside /usr is needed. */
const SYSTEM = ['/etc/libreoffice/registry']

/** The profile lives in the run's own HOME, the sandbox's private, sized tmpfs. */
const PROFILE = '$HOME/profile'

/**
 * The profile LibreOffice starts from: macros never run, whatever the document asks, and no Java.
 * A conversion loads documents with macros off already; this holds if that default ever changes.
 */
const SETTINGS = `<?xml version="1.0" encoding="UTF-8"?>
<oor:items xmlns:oor="http://openoffice.org/2001/registry" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>3</value></prop></item>
<item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="DisableMacrosExecution" oor:op="fuse"><value>true</value></prop></item>
<item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="BlockUntrustedRefererLinks" oor:op="fuse"><value>true</value></prop></item>
<item oor:path="/org.openoffice.Office.Java/VirtualMachine"><prop oor:name="Enable" oor:op="fuse"><value>false</value></prop></item>
<item oor:path="/org.openoffice.Office.Common/Misc"><prop oor:name="UseLocking" oor:op="fuse"><value>false</value></prop></item>
</oor:items>
`

/** Seeds the profile, then converts the input to /out/input.pdf. */
const CONVERT =
  `mkdir -p "${PROFILE}/user" && cp /in/registrymodifications.xcu "${PROFILE}/user/" && ` +
  'exec soffice --headless --norestore --nolockcheck --nodefault --nologo ' +
  `"-env:UserInstallation=file://${PROFILE}" --convert-to pdf --outdir /out "$1"`

/** An Office file as LibreOffice prints it to PDF in the converter sandbox, then as a PDF. */
export async function officePreview(extension: string, bytes: Buffer, slots: ImageSlots): Promise<RenderedPreview> {
  const kind = OFFICE_FORMATS[extension] ?? DOCUMENT
  const failed = (why: string): RenderedPreview => ({
    body: '',
    label: kind.name,
    note: null,
    error: converterError(capital(kind.subject), why),
    thumb: null,
  })
  if (converterPath('soffice') === null) {
    return failed('LibreOffice is not installed on this host')
  }
  const result = await runConverter({
    program: 'sh',
    args: ['-c', CONVERT, 'sh', `/in/input.${extension}`],
    inputs: new Map([
      [`input.${extension}`, bytes],
      ['registrymodifications.xcu', Buffer.from(SETTINGS)],
    ]),
    limits: LIMITS,
    system: SYSTEM,
  })
  const pdf = result.ok ? result.files.get('input.pdf') : undefined
  if (pdf === undefined) {
    return failed(result.ok ? 'LibreOffice made no PDF of it' : result.error)
  }
  return pdfPreview(pdf, slots, kind)
}
