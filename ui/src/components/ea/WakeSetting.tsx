import {
  eaSettingsInput,
  KEEP_AWAKE_MAX_S,
  KEEP_AWAKE_MIN_S,
  type EaSettings,
  type EaSettingsInput,
} from '@seti/shared'
import { Ear, PhoneIncoming } from 'lucide-react'
import { useState, type KeyboardEvent } from 'react'
import { Hint } from '@/components/Hint'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import type { EaSettingsState } from './useEaSettings'

interface FormProps {
  settings: EaSettings
  onSave: (input: EaSettingsInput) => void
}

const sameSettings = (a: EaSettingsInput, b: EaSettingsInput) =>
  a.wake_enabled === b.wake_enabled &&
  a.wake_phrase === b.wake_phrase &&
  a.keep_awake_seconds === b.keep_awake_seconds &&
  a.join_on_open === b.join_on_open

const TOGGLE = 'aria-pressed:border-primary aria-pressed:bg-primary/10 aria-pressed:text-primary'

function WakeForm({ settings, onSave }: FormProps) {
  const [phrase, setPhrase] = useState(settings.wake_phrase)
  const [seconds, setSeconds] = useState(String(settings.keep_awake_seconds))
  const [invalid, setInvalid] = useState<string | null>(null)

  const commit = (patch: Partial<EaSettingsInput> = {}) => {
    const parsed = eaSettingsInput.safeParse({
      wake_enabled: settings.wake_enabled,
      wake_phrase: phrase,
      keep_awake_seconds: Number(seconds),
      join_on_open: settings.join_on_open,
      ...patch,
    })
    if (!parsed.success) {
      setInvalid(parsed.error.issues[0]?.message ?? 'Check the wake word')
      return
    }
    setInvalid(null)
    if (!sameSettings(parsed.data, settings)) {
      onSave(parsed.data)
    }
  }
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      commit()
    }
  }
  const enabled = settings.wake_enabled
  return (
    <>
      <Hint text={`Only answer after "${settings.wake_phrase}"; say it to wake the EA`} side="top">
        <Button
          variant="outline"
          size="xs"
          aria-pressed={enabled}
          onClick={() => {
            commit({ wake_enabled: !enabled })
          }}
          className={TOGGLE}
        >
          <Ear />
          Wake word
        </Button>
      </Hint>
      <Hint text="With Wake word on, Seti joins the call asleep whenever it opens" side="top">
        <Button
          variant="outline"
          size="xs"
          aria-pressed={enabled && settings.join_on_open}
          disabled={!enabled}
          onClick={() => {
            commit({ join_on_open: !settings.join_on_open })
          }}
          className={TOGGLE}
        >
          <PhoneIncoming />
          Join on open
        </Button>
      </Hint>
      <Input
        aria-label="Wake phrase"
        value={phrase}
        maxLength={40}
        aria-invalid={invalid !== null}
        onChange={(e) => {
          setPhrase(e.target.value)
        }}
        onBlur={() => {
          commit()
        }}
        onKeyDown={onKeyDown}
        className="h-6 w-28 px-1.5"
      />
      <Hint text="Seconds after the last exchange that the EA stays awake" side="top">
        <Input
          aria-label="Stay awake"
          type="number"
          inputMode="numeric"
          min={KEEP_AWAKE_MIN_S}
          max={KEEP_AWAKE_MAX_S}
          value={seconds}
          aria-invalid={invalid !== null}
          onChange={(e) => {
            setSeconds(e.target.value)
          }}
          onBlur={() => {
            commit()
          }}
          onKeyDown={onKeyDown}
          className="h-6 w-14 px-1.5"
        />
      </Hint>
      <span className="text-muted-foreground">s awake</span>
      {invalid !== null && (
        <span role="alert" className="min-w-0 truncate text-destructive" title={invalid}>
          {invalid}
        </span>
      )}
    </>
  )
}

/** The wake word setting: off, or on with a phrase and a keep-awake window. */
export function WakeSetting({ state, className }: { state: EaSettingsState; className?: string }) {
  const { settings, error, save } = state
  return (
    <div
      role="group"
      aria-label="Wake word"
      className={cn('flex items-center gap-2 border-t border-border px-3 py-1.5', className)}
    >
      {settings === null ? (
        <span className="text-muted-foreground">{error ?? 'Loading the wake word setting'}</span>
      ) : (
        <WakeForm
          key={settings.updated_at ?? 'default'}
          settings={settings}
          onSave={(input) => {
            void save(input)
          }}
        />
      )}
      {settings !== null && error !== null && (
        <span role="alert" className="min-w-0 truncate text-destructive" title={error}>
          {error}
        </span>
      )}
    </div>
  )
}
