import { AudioWaveform, Gauge, Mic, Volume2, Wind, type LucideIcon } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { toast } from 'sonner'
import { ToggleButton } from '@/components/ToggleButton'
import { Button } from '@/components/ui/button'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { MeterBars } from './MeterBars'
import {
  micConstraints,
  outputChoice,
  PHONE_OUTPUT_NOTES,
  phoneOutput,
  PROCESSING,
  type DeviceOption,
  type PhoneOutput,
  type Processing,
} from './audio-prefs'
import type { AudioState } from './audio-store'
import { useEaAudio, useEaAudioStore, useEaCall } from './call-context'
import { callActive } from './call-state'
import { micError } from './media'
import { playTestTone } from './test-tone'

const SYSTEM_DEFAULT = ''

function DeviceSelect({
  label,
  value,
  options,
  onChange,
  disabled = false,
}: {
  label: string
  value: string | null
  options: readonly DeviceOption[]
  onChange: (id: string | null) => void
  disabled?: boolean
}) {
  return (
    <NativeSelect
      aria-label={label}
      size="sm"
      disabled={disabled}
      value={value ?? SYSTEM_DEFAULT}
      onChange={(e) => {
        onChange(e.target.value === SYSTEM_DEFAULT ? null : e.target.value)
      }}
      className="w-72 min-w-0 max-md:w-full"
    >
      <NativeSelectOption value={SYSTEM_DEFAULT}>System default</NativeSelectOption>
      {options.map((device) => (
        <NativeSelectOption key={device.id} value={device.id}>
          {device.label}
        </NativeSelectOption>
      ))}
    </NativeSelect>
  )
}

function AllowMic() {
  const store = useEaAudioStore()
  return (
    <Button
      variant="outline"
      size="sm"
      title="Allow microphone to list devices"
      onClick={() => {
        void store.allow()
      }}
    >
      <Mic />
      Allow mic
    </Button>
  )
}

export function MicPicker() {
  const audio = useEaAudio()
  const store = useEaAudioStore()
  if (!audio.listed) {
    return <AllowMic />
  }
  return <DeviceSelect label="Microphone" value={audio.mic.id} options={audio.mics} onChange={store.chooseMic} />
}

const thisPhone = (): PhoneOutput | null => phoneOutput(navigator.userAgent, navigator.maxTouchPoints)

/** Waiting for the microphone before speakers can be listed, which a phone never lists. */
const awaitingList = (audio: AudioState, phone: PhoneOutput | null) =>
  phone === null && audio.sinkSupported && !audio.listed

/** The output picker, greyed out where the browser or the phone picks the output itself. */
export function SpeakerPicker() {
  const audio = useEaAudio()
  const store = useEaAudioStore()
  if (outputChoice(audio.sinkSupported, audio)) {
    return (
      <DeviceSelect label="Speaker" value={audio.speaker.id} options={audio.speakers} onChange={store.chooseSpeaker} />
    )
  }
  if (awaitingList(audio, thisPhone())) {
    return null
  }
  return <DeviceSelect label="Speaker" value={null} options={[]} onChange={store.chooseSpeaker} disabled />
}

/** Why there is no output picker, or null when there is one. */
function outputNote(audio: AudioState): string | null {
  if (outputChoice(audio.sinkSupported, audio)) {
    return null
  }
  const phone = thisPhone()
  if (phone !== null) {
    return PHONE_OUTPUT_NOTES[phone]
  }
  if (awaitingList(audio, phone)) {
    return 'Speakers are listed once the microphone is allowed.'
  }
  return 'This browser plays the EA on the system output.'
}

const missingNote = (label: string) => `${label} is not connected; the system default is used.`

/** Quiet notes about the devices: a saved one that is gone, or why none can be listed. */
export function DeviceNotes({ kind }: { kind: 'mic' | 'speaker' }) {
  const audio = useEaAudio()
  const missing = audio[kind].missing
  const lines: ReactNode[] = []
  if (kind === 'mic' && audio.blocked !== null) {
    lines.push(
      <span key="blocked" role="alert" className="text-destructive">
        {audio.blocked}
      </span>,
    )
  } else if (kind === 'mic' && !audio.listed) {
    lines.push(<span key="allow">Allow microphone to list devices.</span>)
  }
  if (kind === 'speaker') {
    const note = outputNote(audio)
    if (note !== null) {
      lines.push(<span key="output">{note}</span>)
    }
  }
  if (missing !== null) {
    lines.push(<span key="missing">{missingNote(missing.label)}</span>)
  }
  if (lines.length === 0) {
    return null
  }
  return (
    <span className="mt-1 flex flex-col text-muted-foreground" data-testid={`ea-${kind}-note`}>
      {lines}
    </span>
  )
}

export function TestSpeaker() {
  const { speaker, sinkSupported } = useEaAudio()
  return (
    <Button
      variant="outline"
      size="sm"
      title="Play a short chime on the chosen output"
      onClick={() => {
        playTestTone(speaker.id, sinkSupported).catch(() => {
          toast.error('Could not play the test tone')
        })
      }}
    >
      <Volume2 />
      Test speaker
    </Button>
  )
}

const stopTracks = (stream: MediaStream) => {
  for (const track of stream.getTracks()) {
    track.stop()
  }
}

interface Preview {
  track: MediaStreamTrack | null
  error: string | null
}

/** Opens the microphone for a level check while `constraints` is set; a new value reopens it. */
function usePreviewTrack(constraints: MediaTrackConstraints | null, onOpened: () => void): Preview {
  const [result, setResult] = useState<(Preview & { for: MediaTrackConstraints }) | null>(null)
  useEffect(() => {
    if (constraints === null) {
      return undefined
    }
    let stream: MediaStream | null = null
    let stopped = false
    navigator.mediaDevices.getUserMedia({ audio: constraints }).then(
      (opened) => {
        if (stopped) {
          stopTracks(opened)
          return
        }
        stream = opened
        setResult({ for: constraints, track: opened.getAudioTracks()[0] ?? null, error: null })
        onOpened()
      },
      (e: unknown) => {
        if (!stopped) {
          setResult({ for: constraints, track: null, error: micError(e) })
        }
      },
    )
    return () => {
      stopped = true
      if (stream !== null) {
        stopTracks(stream)
      }
    }
  }, [constraints, onOpened])
  if (result !== null && constraints !== null && result.for === constraints) {
    return result
  }
  return { track: null, error: null }
}

/** The input level of the chosen microphone: the call's own while one is live, else a test. */
export function MicTest() {
  const call = useEaCall()
  const audio = useEaAudio()
  const store = useEaAudioStore()
  const [testing, setTesting] = useState(false)
  const live = callActive(call.phase)
  const { prefs } = audio
  const micId = audio.mic.id
  const constraints = useMemo(
    () => (testing && !live ? micConstraints(prefs, micId) : null),
    [testing, live, prefs, micId],
  )
  const listDevices = useCallback(() => {
    void store.refresh()
  }, [store])
  const preview = usePreviewTrack(constraints, listDevices)
  const callTrack = call.micOn ? call.tracks.local : null
  const track = live ? callTrack : preview.track
  return (
    <>
      <MeterBars track={track} active={track !== null} tone="user" count={15} className="h-6" />
      {!live && (
        <ToggleButton
          pressed={testing}
          onPressedChange={setTesting}
          icon={Mic}
          label="Test mic"
          hint={testing ? 'Close the microphone' : 'Show the input level of the chosen microphone'}
        />
      )}
      {preview.error !== null && (
        <span role="alert" className="text-destructive">
          {preview.error}
        </span>
      )}
    </>
  )
}

const PROCESSING_LOOK: Record<Processing, { label: string; icon: LucideIcon; hint: string }> = {
  echoCancellation: {
    label: 'Cancel echo',
    icon: AudioWaveform,
    hint: "Echo cancellation: keeps the EA's voice out of your microphone",
  },
  noiseSuppression: { label: 'Denoise', icon: Wind, hint: 'Noise suppression: filters steady background noise' },
  autoGainControl: { label: 'Auto gain', icon: Gauge, hint: 'Auto gain: evens out how loud you sound' },
}

export function ProcessingToggles() {
  const { prefs } = useEaAudio()
  const store = useEaAudioStore()
  return (
    <div role="group" aria-label="Mic processing" className="flex flex-wrap items-center gap-1.5">
      {PROCESSING.map((key) => (
        <ToggleButton
          key={key}
          pressed={prefs[key]}
          onPressedChange={(on) => {
            store.setProcessing(key, on)
          }}
          icon={PROCESSING_LOOK[key].icon}
          label={PROCESSING_LOOK[key].label}
          hint={PROCESSING_LOOK[key].hint}
        />
      ))}
    </div>
  )
}
