import { Square } from 'lucide-react'
import { useState } from 'react'
import { Hint } from '@/components/Hint'
import { Button } from '@/components/ui/button'

interface StopProps {
  label: string
  hint: string
  onStop: () => Promise<void>
}

/** A row's stop button, off while its stop is on the way. */
export function StopButton({ label, hint, onStop }: StopProps) {
  const [stopping, setStopping] = useState(false)
  const stop = async () => {
    setStopping(true)
    await onStop().finally(() => {
      setStopping(false)
    })
  }
  return (
    <Hint text={hint}>
      <Button variant="outline" size="xs" disabled={stopping} aria-label={label} onClick={() => void stop()}>
        <Square />
        <span className="max-sm:hidden">Stop</span>
      </Button>
    </Hint>
  )
}
