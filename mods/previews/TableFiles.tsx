import { Code, Download } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { SheetView } from './SheetView'
import { DELIMITER_NAMES, detectDelimiter, parseDelimited } from './csv'
import { BOOK_CELL_MAX, type Grid, type ParsedSheet } from './grid'
import { useKit } from './kit'
import { parseWorkbook } from './workbook'

/** Cells a csv keeps in the table; rows past it are left to the download. */
const CSV_CELL_MAX = 2_000_000
/** The raw view of a csv too big to edit shows its start only. */
const RAW_PREVIEW_CHARS = 256 * 1024

const NO_FORMULAS: ReadonlyMap<string, string> = new Map()

function Notice({ text, download, name }: { text: string; download: string; name: string }) {
  const { Button } = useKit()
  return (
    <div
      role="status"
      className="flex shrink-0 flex-wrap items-center gap-2 border-b border-warning/40 bg-warning/10 px-3 py-1.5 text-xs"
    >
      <span className="min-w-0 flex-1">{text}</span>
      <Button variant="outline" size="xs" asChild>
        <a href={download} download={name}>
          <Download />
          Download
        </a>
      </Button>
    </div>
  )
}

/** A csv or tsv as a table: the delimiter guessed for csv, tab for tsv. */
export function DelimitedTable({ text, name, download }: { text: string; name: string; download: string }) {
  const parsed = useMemo(() => {
    const delimiter = /\.tsv$/i.test(name) ? '\t' : detectDelimiter(text)
    return { delimiter, ...parseDelimited(text, delimiter, { maxCells: CSV_CELL_MAX }) }
  }, [text, name])
  const grid: Grid = useMemo(
    () => ({
      rows: parsed.rows,
      columns: parsed.columns,
      formulas: NO_FORMULAS,
      merges: [],
      truncated: parsed.truncated,
    }),
    [parsed],
  )
  const notice = parsed.truncated ? (
    <Notice
      text={`Showing the first ${parsed.rows.length.toLocaleString('en-US')} rows; the rest pass the ${CSV_CELL_MAX.toLocaleString('en-US')} cell limit.`}
      download={download}
      name={name}
    />
  ) : null
  return (
    <SheetView
      key={parsed.delimiter}
      grid={grid}
      label={`${name}, ${DELIMITER_NAMES[parsed.delimiter].toLowerCase()} separated`}
      headerFirst
      notice={notice}
    />
  )
}

type Loaded<T> = { value: T } | { error: string } | null

/** What `read` made of the file at `url`, null until it is ready, kept per url. */
function useLoaded<T>(url: string, read: (res: Response) => Promise<T>): Loaded<T> {
  const { fetchRaw, errorText } = useKit()
  const [loaded, setLoaded] = useState<{ url: string; result: Loaded<T> }>({ url: '', result: null })
  useEffect(() => {
    const controller = new AbortController()
    fetchRaw(url, controller.signal)
      .then(read)
      .then(
        (value) => {
          setLoaded({ url, result: { value } })
        },
        (e: unknown) => {
          if (!controller.signal.aborted) {
            setLoaded({ url, result: { error: errorText(e) } })
          }
        },
      )
    return () => {
      controller.abort()
    }
  }, [url, read, fetchRaw, errorText])
  return loaded.url === url ? loaded.result : null
}

const readText = async (res: Response) => res.text()

const MONO = 'font-mono text-xs leading-relaxed [font-variant-ligatures:none]'

/** A csv past the editor's cap: read-only, as a table or as the start of its text. */
export function CsvFile({ url, name, download }: { url: string; name: string; download: string }) {
  const { ToggleButton, cn } = useKit()
  const loaded = useLoaded(url, readText)
  const [source, setSource] = useState(false)
  if (loaded === null) {
    return <p className="p-4 text-sm text-muted-foreground">Loading...</p>
  }
  if ('error' in loaded) {
    return <p className="p-4 text-sm text-destructive">{loaded.error}</p>
  }
  const text = loaded.value
  const clipped = text.length > RAW_PREVIEW_CHARS
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-1.5">
        <ToggleButton
          pressed={source}
          onPressedChange={setSource}
          icon={<Code />}
          label="Source"
          hint={source ? 'Back to the table' : 'Show the text'}
        />
        <span className="text-xs text-muted-foreground">Too large to edit here</span>
      </div>
      {source ? (
        <div className="min-h-0 flex-1 overflow-auto px-4 py-3">
          {clipped && (
            <p className="mb-2 text-xs text-muted-foreground">The first 256 KB; download the file for the rest.</p>
          )}
          <pre className={cn(MONO, 'break-all whitespace-pre-wrap')}>
            {clipped ? text.slice(0, RAW_PREVIEW_CHARS) : text}
          </pre>
        </div>
      ) : (
        <DelimitedTable text={text} name={name} download={download} />
      )}
    </div>
  )
}

const readBytes = async (res: Response) => res.arrayBuffer()

function useWorkbook(url: string): Loaded<ParsedSheet[]> {
  const { errorText } = useKit()
  const bytes = useLoaded(url, readBytes)
  const data = bytes !== null && 'value' in bytes ? bytes.value : null
  const [parsed, setParsed] = useState<{ data: ArrayBuffer | null; result: Loaded<ParsedSheet[]> }>({
    data: null,
    result: null,
  })
  useEffect(() => {
    if (data === null) {
      return undefined
    }
    const controller = new AbortController()
    parseWorkbook(data.slice(0), controller.signal).then(
      (value) => {
        setParsed({ data, result: { value } })
      },
      (e: unknown) => {
        if (!controller.signal.aborted) {
          setParsed({ data, result: { error: `Could not read the workbook: ${errorText(e)}` } })
        }
      },
    )
    return () => {
      controller.abort()
    }
  }, [data, errorText])
  if (bytes === null || 'error' in bytes) {
    return bytes
  }
  return parsed.data === data ? parsed.result : null
}

/** An xlsx, xls or ods workbook, read-only, one sheet at a time. */
export function WorkbookFile({ url, name, download }: { url: string; name: string; download: string }) {
  const loaded = useWorkbook(url)
  const [active, setActive] = useState(0)
  if (loaded === null) {
    return <p className="p-4 text-sm text-muted-foreground">Reading the workbook...</p>
  }
  if ('error' in loaded) {
    return <p className="p-4 text-sm text-destructive">{loaded.error}</p>
  }
  const sheets = loaded.value
  const sheet = sheets[Math.min(active, sheets.length - 1)]
  if (sheet === undefined) {
    return <p className="p-4 text-sm text-muted-foreground">This workbook has no sheets.</p>
  }
  const notice = sheet.truncated ? (
    <Notice
      text={`Some rows are left out to keep the workbook within ${BOOK_CELL_MAX.toLocaleString('en-US')} cells.`}
      download={download}
      name={name}
    />
  ) : null
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {sheets.length > 1 && (
        <div role="tablist" aria-label="Sheets" className="flex shrink-0 overflow-x-auto border-b border-border">
          {sheets.map((each, index) => (
            <button
              key={each.name}
              type="button"
              role="tab"
              aria-selected={each === sheet}
              onClick={() => {
                setActive(index)
              }}
              className="shrink-0 border-r border-border px-3 py-1.5 text-xs whitespace-nowrap text-muted-foreground hover:bg-muted aria-selected:bg-background aria-selected:font-medium aria-selected:text-foreground aria-selected:shadow-[inset_0_-2px_0_var(--primary)]"
            >
              {each.name}
            </button>
          ))}
        </div>
      )}
      <SheetView
        key={sheet.name}
        grid={sheet}
        label={`${name}, sheet ${sheet.name}`}
        headerFirst={false}
        notice={notice}
      />
    </div>
  )
}
