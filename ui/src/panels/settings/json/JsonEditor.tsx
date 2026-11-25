import { autocompletion } from '@codemirror/autocomplete'
import { pathText, type SettingsDoc, type SettingsWriteRefusal } from '@seti/shared'
import { Check, ExternalLink, X } from 'lucide-react'
import { useMemo, useState } from 'react'
import { CodeEditor } from '@/components/code-editor/CodeEditor'
import { Button } from '@/components/ui/button'
import { navigate } from '@/lib/route'
import { PreviewDialog } from './PreviewDialog'
import { schemaCompletion, type JsonSchema } from './json-complete'
import { editableSchema, editableText, planSave } from './json-edit'
import { problemMarks } from './json-marks'
import { keySpans, lineOfPath } from './json-scan'
import { useWrite } from './use-write'

/** One thing wrong with the edited text, at a line when Seti knows it. */
interface Problem {
  message: string
  line: number | null
  page?: string | undefined
}

function problemsOf(refusal: SettingsWriteRefusal, text: string): Problem[] {
  if (refusal.problems.length === 0) {
    return [{ message: refusal.detail, line: null }]
  }
  return refusal.problems.map((problem) => ({
    message: `${pathText(problem.path)}: ${problem.message}`,
    line: lineOfPath(text, problem.path),
    page: problem.page,
  }))
}

function Problems({ problems }: { problems: Problem[] }) {
  if (problems.length === 0) {
    return null
  }
  return (
    <ul role="alert" aria-label="Problems" className="space-y-1 border border-destructive/40 px-3 py-2 text-xs">
      {problems.map((problem) => (
        <li key={`${String(problem.line)} ${problem.message}`} className="flex flex-wrap items-center gap-x-2 gap-y-1">
          {problem.line !== null && <span className="font-mono text-destructive">Line {problem.line}</span>}
          <span className="min-w-0 wrap-anywhere">{problem.message}</span>
          {problem.page !== undefined && (
            <Button
              size="xs"
              variant="ghost"
              onClick={() => {
                navigate('settings', problem.page)
              }}
            >
              <ExternalLink />
              Open page
            </Button>
          )}
        </li>
      ))}
    </ul>
  )
}

/** Edits the plain settings as JSON: completion from the schema, a preview, then one save. */
export function JsonEditor({
  doc,
  schema,
  onClose,
  onSaved,
}: {
  doc: SettingsDoc
  schema: JsonSchema | null
  onClose: () => void
  onSaved: () => void
}) {
  const [text, setText] = useState(() => editableText(doc))
  const [problems, setProblems] = useState<Problem[]>([])
  const write = useWrite(
    () => {
      onSaved()
      onClose()
    },
    (refusal) => {
      setProblems(problemsOf(refusal, text))
    },
  )
  const extensions = useMemo(() => {
    const lines = problems.flatMap((problem) => (problem.line === null ? [] : [problem.line]))
    const complete =
      schema === null ? [] : [autocompletion({ override: [schemaCompletion(editableSchema(schema), keySpans)] })]
    return [...complete, problemMarks(lines)]
  }, [schema, problems])

  const review = () => {
    const plan = planSave(doc, text)
    if (plan.ok) {
      setProblems([])
      write.open(plan)
    } else {
      setProblems([{ message: plan.message, line: plan.line }])
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <p className="min-w-0 flex-1 basis-56 text-xs text-muted-foreground">
          Plain settings only. Security settings and secrets change on their own pages.
        </p>
        <Button size="sm" variant="outline" onClick={onClose}>
          <X />
          Cancel
        </Button>
        <Button size="sm" onClick={review}>
          <Check />
          Save
        </Button>
      </div>
      <Problems problems={problems} />
      <CodeEditor
        value={text}
        onChange={setText}
        label="Settings JSON"
        language="json"
        className="min-h-[60vh]"
        onSave={review}
        extensions={extensions}
      />
      {write.planned !== null && (
        <PreviewDialog
          rows={write.planned.rows}
          confirm={write.confirm}
          busy={write.busy}
          onSave={() => void write.save()}
          onClose={write.close}
        />
      )}
    </div>
  )
}
