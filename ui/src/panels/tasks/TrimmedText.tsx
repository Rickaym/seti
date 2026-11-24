import { type WireRow, jsonText, type CodeLanguage } from '@seti/shared'
import { Maximize2 } from 'lucide-react'
import { useMemo, useState } from 'react'
import { toast } from 'sonner'
import { apiGet, errorText } from '@/api'
import { CODE_COPY, CODE_COPY_ROOM, CopyIconButton } from '@/components/CopyButton'
import { HighlightedCode } from '@/components/highlight/HighlightedCode'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { asEvents } from '@/lib/wire'

/** Where the full text of a trimmed call input or result is fetched from. */
export interface FullSource {
  taskId: string
  rowId: number
  toolUseId: string
  pick: (row: WireRow, toolUseId: string) => string
}

interface TrimmedTextProps {
  text: string
  /** Where to fetch the full text from, or null when `text` is complete. */
  source: FullSource | null
  label: string
  className: string
  /** The copy button's name, such as Copy command. */
  copy?: string
  /** Colours the text as this language; left out, JSON is found, indented and coloured. */
  language?: CodeLanguage
}

/** The text to show and its language: JSON comes back indented when no language is given. */
function shownCode(text: string, language: CodeLanguage | undefined): { code: string; language: CodeLanguage | null } {
  if (language !== undefined) {
    return { code: text, language }
  }
  const json = jsonText(text)
  return json === null ? { code: text, language: null } : { code: json, language: 'json' }
}

export function TrimmedText({ text, source, label, className, copy = 'Copy code', language }: TrimmedTextProps) {
  const [full, setFull] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const shown = useMemo(() => shownCode(full ?? text, language), [full, text, language])

  const load = async (from: FullSource) => {
    setLoading(true)
    try {
      const row = await apiGet<WireRow>(asEvents(`/tasks/${from.taskId}/messages/${String(from.rowId)}`))
      setFull(from.pick(row, from.toolUseId))
    } catch (e) {
      toast.error(errorText(e))
    } finally {
      setLoading(false)
    }
  }

  return (
    <>
      <div className="group/code relative">
        <pre className={cn('overflow-auto break-all whitespace-pre-wrap', CODE_COPY_ROOM, className)}>
          <HighlightedCode code={shown.code} language={shown.language} />
        </pre>
        <CopyIconButton text={shown.code} label={copy} className={CODE_COPY} />
      </div>
      {source !== null && full === null && (
        <div className="flex items-center gap-2 text-muted-foreground">
          <span>Trimmed for display.</span>
          <Button variant="outline" size="xs" disabled={loading} onClick={() => void load(source)}>
            <Maximize2 />
            {loading ? 'Loading...' : label}
          </Button>
        </div>
      )}
    </>
  )
}
