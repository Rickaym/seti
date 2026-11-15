import { EA_CLIENT_MESSAGES } from '@seti/shared'
import { Headphones, Mic, MicOff, Moon, Phone, PhoneOff } from 'lucide-react'
import type { ComponentProps, ReactElement } from 'react'
import { toast } from 'sonner'
import { Hint } from '@/components/Hint'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useEaCallStore } from './call-context'
import { asleep, callActive, type CallState } from './call-state'
import { CALL_SHORTCUT } from './call-status'
import type { EaCallStore } from './call-store'

const PRESSED = 'aria-pressed:border-primary aria-pressed:bg-primary/10 aria-pressed:text-primary'

/** Touch screens have no hover, so their buttons skip the hint and grow to a thumb's size. */
function Control({ hint, touch, ...props }: ComponentProps<typeof Button> & { hint: string; touch: boolean }) {
  const button: ReactElement = (
    <Button
      size={touch ? 'lg' : 'sm'}
      {...props}
      className={cn('flex-1', touch ? 'h-11 px-1.5 text-sm' : 'h-8', props.className)}
    />
  )
  return touch ? button : <Hint text={hint}>{button}</Hint>
}

/** A phone too narrow for four thumb-sized buttons wraps them instead of overflowing. */
const row = (touch: boolean, className?: string) => cn('flex gap-2 px-3 pb-3', touch && 'flex-wrap gap-1.5', className)

async function reroute(store: EaCallStore): Promise<void> {
  if (!(await store.reroute())) {
    toast.error('Could not reroute the call', { description: 'Hang up and call again.', duration: Infinity })
  }
}

interface CallControlsProps {
  call: CallState
  canStart: boolean
  touch: boolean
  className?: string
}

export function CallControls({ call, canStart, touch, className }: CallControlsProps) {
  const store = useEaCallStore()
  const connected = call.phase === 'connected'
  const sleeping = asleep(call)
  if (!callActive(call.phase)) {
    return (
      <div className={row(touch, className)}>
        <Control
          touch={touch}
          hint={`Start a call (${CALL_SHORTCUT.label})`}
          disabled={!canStart}
          onClick={() => void store.connect()}
        >
          <Phone />
          Call
        </Control>
      </div>
    )
  }
  return (
    <div className={row(touch, className)}>
      <Control
        touch={touch}
        hint={call.micOn ? 'Mute your microphone' : 'Unmute your microphone'}
        variant="outline"
        className={PRESSED}
        disabled={!connected}
        aria-pressed={!call.micOn}
        onClick={() => {
          store.setMic(!call.micOn)
        }}
      >
        {call.micOn ? <Mic /> : <MicOff />}
        Mute
      </Control>
      <Control
        touch={touch}
        hint={sleeping ? 'Wake the EA as if you said its phrase' : 'The EA ignores speech until its wake phrase'}
        variant="outline"
        className={PRESSED}
        disabled={!connected}
        aria-pressed={sleeping}
        onClick={() => {
          store.notify(sleeping ? EA_CLIENT_MESSAGES.wake : EA_CLIENT_MESSAGES.sleep)
        }}
      >
        <Moon />
        Sleep
      </Control>
      <Control
        touch={touch}
        hint="Move the call to your headset or the output in use now"
        variant="outline"
        disabled={!connected}
        onClick={() => void reroute(store)}
      >
        <Headphones />
        Reroute
      </Control>
      <Control
        touch={touch}
        hint={`Hang up (${CALL_SHORTCUT.label})`}
        variant="destructive"
        onClick={() => void store.hangUp()}
      >
        <PhoneOff />
        Hang up
      </Control>
    </div>
  )
}
