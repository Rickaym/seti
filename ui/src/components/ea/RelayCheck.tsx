import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { testRelay, type RelayResult } from './relay-test'

function describe(result: RelayResult): { text: string; tone: 'muted' | 'ok' | 'bad' } {
  switch (result.status) {
    case 'idle':
      return { text: 'Not tested', tone: 'muted' }
    case 'running':
      return { text: 'Testing...', tone: 'muted' }
    case 'ok': {
      const via = result.address === null ? '' : ` via ${result.address}`
      return { text: `Relay works, ${String(result.ms)} ms${via}`, tone: 'ok' }
    }
    case 'skipped':
      return { text: result.reason, tone: 'muted' }
    case 'error':
      return { text: result.message, tone: 'bad' }
  }
}

export function RelayCheck() {
  const [result, setResult] = useState<RelayResult>({ status: 'idle' })
  const { text, tone } = describe(result)
  return (
    <span className="inline-flex min-w-0 items-center gap-2">
      <span
        className={cn(
          'truncate',
          tone === 'ok' && 'text-success',
          tone === 'bad' && 'text-destructive',
          tone === 'muted' && 'text-muted-foreground',
        )}
        title={text}
      >
        {text}
      </span>
      <Button
        variant="link"
        size="xs"
        className="h-auto px-0"
        disabled={result.status === 'running'}
        onClick={() => {
          setResult({ status: 'running' })
          void testRelay().then(setResult)
        }}
      >
        Test relay
      </Button>
    </span>
  )
}
