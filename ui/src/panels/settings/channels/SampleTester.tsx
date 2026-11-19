import type { SenderSampleInput, SenderSampleResult } from '@seti/shared'
import { FlaskConical } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { apiPost, errorText } from '@/api'
import { Hint } from '@/components/Hint'
import { Field } from '@/components/crud/CrudForm'
import { FindableTextarea } from '@/components/find/FindableTextarea'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

/** What checks the sample: a webhook's own sender and secret, or a draft with a typed secret. */
export type SampleTarget = Pick<SenderSampleInput, 'channel_id' | 'preset' | 'definition' | 'secret'>

function Result({ result }: { result: SenderSampleResult }) {
  return (
    <div className="col-span-full border border-border p-2" data-testid="sample-result">
      <div className={cn('font-semibold', result.verified ? 'text-success' : 'text-destructive')}>
        {result.verified ? 'Signature verifies' : 'Does not verify'}
      </div>
      {result.reason !== '' && <div className="text-muted-foreground">{result.reason}</div>}
      {result.event !== null && (
        <dl className="mt-1 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5">
          <dt className="text-muted-foreground">Event</dt>
          <dd className="font-mono break-all">{result.event.kind === '' ? 'no name' : result.event.kind}</dd>
          <dt className="text-muted-foreground">Title</dt>
          <dd className="break-words">{result.event.title}</dd>
          <dt className="text-muted-foreground">Link</dt>
          <dd className="break-all">{result.event.url ?? 'none'}</dd>
        </dl>
      )}
    </div>
  )
}

/** Checks a captured request on the server, so a sender is set up without trial deliveries. */
export function SampleTester({ target }: { target: () => SampleTarget }) {
  const [headers, setHeaders] = useState('')
  const [body, setBody] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<SenderSampleResult | null>(null)
  const check = async () => {
    setBusy(true)
    try {
      const input: SenderSampleInput = { ...target(), headers, body }
      setResult(await apiPost<SenderSampleResult>('/channels/sample', input))
    } catch (e) {
      setResult(null)
      toast.error(errorText(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <Field label="Sample headers" full>
        <FindableTextarea
          aria-label="Sample headers"
          placeholder={'X-Signature: sha256=...\nX-Event: issue'}
          className="min-h-20 font-mono text-xs"
          spellCheck={false}
          value={headers}
          onChange={(e) => {
            setHeaders(e.target.value)
          }}
        />
      </Field>
      <Field label="Sample body" full>
        <FindableTextarea
          aria-label="Sample body"
          placeholder='{"type":"issue","data":{"title":"..."}}'
          className="min-h-24 font-mono text-xs"
          spellCheck={false}
          value={body}
          onChange={(e) => {
            setBody(e.target.value)
          }}
        />
      </Field>
      <div className="col-span-full flex justify-end">
        <Hint text="Check the pasted request with the secret; nothing is stored or sent on">
          <Button type="button" size="sm" variant="outline" disabled={busy || body === ''} onClick={() => void check()}>
            <FlaskConical />
            Check
          </Button>
        </Hint>
      </div>
      {result !== null && <Result result={result} />}
    </>
  )
}
