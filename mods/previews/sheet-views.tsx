import type { ModFileViewProps } from '@seti/mod-api'
import { CsvFile, DelimitedTable, WorkbookFile } from './TableFiles'

/** A csv or tsv: its text when Seti read it (up to 2 MB), else loaded from `url`. */
export function TableView({ text, url, name, download }: ModFileViewProps) {
  return text === null ? (
    <CsvFile url={url} name={name} download={download} />
  ) : (
    <DelimitedTable text={text} name={name} download={download} />
  )
}

/** An xlsx, xlsm, xls or ods workbook, read in a worker. */
export function WorkbookView({ url, name, download }: ModFileViewProps) {
  return <WorkbookFile url={url} name={name} download={download} />
}
