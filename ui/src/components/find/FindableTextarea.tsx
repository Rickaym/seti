import { useEffect, useLayoutEffect, useRef, useState, type ChangeEvent, type ComponentProps } from 'react'
import { FieldMarks } from '@/components/find/FieldMarks'
import { TextFindBar } from '@/components/find/FindBar'
import { FieldFindButton } from '@/components/find/FindButton'
import { useFieldFind } from '@/components/find/useFieldFind'
import { useFind, type FindState } from '@/components/find/useFind'
import { useFindKeys } from '@/components/find/useFindKeys'
import { Textarea } from '@/components/ui/textarea'
import { useCoarsePointer } from '@/hooks/useMedia'
import { cn } from '@/lib/utils'

/** The bare field, for text find must stay out of: a secret, or the terminal's input line. */
export { Textarea as PlainTextarea }

/** A field shorter than this holds one line, where the corner button would cover the caret. */
const ROOMY_PX = 48

type FindableTextareaProps = ComponentProps<'textarea'> & {
  /** Find the screen owns, showing its bar and Find button itself; without it the field has its own. */
  find?: FindState
  /** Lays out the field's box, such as `flex-1` to fill a column. */
  boxClassName?: string
  /** The text of a field bound without `value`, so find recounts when its owner rewrites it. */
  findText?: string
}

/** Whether `field` is tall enough for the corner Find button, followed as it grows. */
function useRoomy(field: HTMLElement | null, watch: boolean): boolean {
  const [roomy, setRoomy] = useState(false)
  useEffect(() => {
    if (field === null || !watch) {
      return undefined
    }
    const observer = new ResizeObserver(() => {
      setRoomy(field.offsetHeight >= ROOMY_PX)
    })
    observer.observe(field)
    return () => {
      observer.disconnect()
    }
  }, [field, watch])
  return roomy
}

/** The field's text: its value or `findText` when the caller holds it, else what was typed. */
function useFieldText({ value, onChange }: ComponentProps<'textarea'>, findText: string | undefined) {
  const [typed, setTyped] = useState('')
  const held = typeof value === 'string' ? value : findText
  if (held !== undefined) {
    return { text: held, onChange }
  }
  return {
    text: typed,
    onChange: (e: ChangeEvent<HTMLTextAreaElement>) => {
      setTyped(e.target.value)
      onChange?.(e)
    },
  }
}

/**
 * Seti's multi-line text field: Ctrl+F (Cmd+F on Apple) finds in its text and Ctrl+H (Cmd+Opt+F)
 * replaces, with every match marked. The keys stay with the field, so the chat find and the
 * browser's own find do not open while it has focus. On a touch screen a long field shows a Find
 * button in its corner while it has focus.
 */
export function FindableTextarea({ find: given, boxClassName, findText, ...props }: FindableTextareaProps) {
  const own = useFind()
  const find = given ?? own
  const touch = useCoarsePointer()
  const [root, setRoot] = useState<HTMLDivElement | null>(null)
  const [field, setField] = useState<HTMLTextAreaElement | null>(null)
  const fieldRef = useRef<HTMLTextAreaElement | null>(null)
  useLayoutEffect(() => {
    fieldRef.current = root?.querySelector('textarea') ?? null
    setField(fieldRef.current)
  }, [root])
  const { text, onChange } = useFieldText(props, findText)
  const editable = props.disabled !== true && props.readOnly !== true
  const marks = useFieldFind(fieldRef, find, text, editable)
  useFindKeys(root, find, { find: true, replace: editable, line: false })
  const corner = given === undefined && touch && find.mode === null
  const roomy = useRoomy(field, corner)

  const parts = (
    <>
      <Textarea {...props} onChange={onChange} />
      <FieldMarks field={field} found={marks} />
      {corner && roomy && <FieldFindButton find={find} />}
    </>
  )
  if (given !== undefined) {
    return (
      <div ref={setRoot} className={cn('relative flex min-w-0 flex-col', boxClassName)}>
        {parts}
      </div>
    )
  }
  return (
    <div ref={setRoot} className={cn('group/find flex w-full min-w-0 flex-col', boxClassName)}>
      <TextFindBar find={find} editable={editable} />
      <div className="relative flex min-h-0 flex-1 flex-col">{parts}</div>
    </div>
  )
}
