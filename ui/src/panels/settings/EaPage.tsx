import { EA_CLIENT_MESSAGES, type EaHealth } from '@seti/shared'
import { VolumeX } from 'lucide-react'
import { useCallback } from 'react'
import { ToggleButton } from '@/components/ToggleButton'
import { AddressSetting } from '@/components/ea/AddressSetting'
import {
  DeviceNotes,
  MicPicker,
  MicTest,
  ProcessingToggles,
  SpeakerPicker,
  TestSpeaker,
} from '@/components/ea/AudioDevices'
import { LiveContextCard } from '@/components/ea/LiveContextCard'
import { RelayCheck } from '@/components/ea/RelayCheck'
import { SetupCard } from '@/components/ea/SetupCard'
import { UsageCard } from '@/components/ea/UsageCard'
import { WakeSetting } from '@/components/ea/WakeSetting'
import { useEaCall, useEaCallStore } from '@/components/ea/call-context'
import { lastEndText } from '@/components/ea/call-end'
import type { Latency } from '@/components/ea/call-state'
import { CALL_SHORTCUT } from '@/components/ea/call-status'
import { setupNeed, useEaHealth } from '@/components/ea/useEaHealth'
import { useEaSettings } from '@/components/ea/useEaSettings'
import { SettingRow, SettingsBody, SettingsCard, SettingsHeader } from './layout'

function relayText(health: EaHealth | null): string {
  if (health === null) {
    return '-'
  }
  return health.turn ? 'TURN' : 'STUN only'
}

const latencyText = (latency: Latency | null) =>
  latency === null ? '-' : `${String(Math.round(latency.last))} ms, avg ${String(Math.round(latency.average))} ms`

export function EaPage() {
  const store = useEaCallStore()
  const call = useEaCall()
  const { state, refresh } = useEaHealth()
  const need = setupNeed(state)
  const health = state.status === 'up' ? state.health : null
  const settings = useEaSettings(
    useCallback(() => {
      store.notify(EA_CLIENT_MESSAGES.settingsChanged)
    }, [store]),
  )
  return (
    <SettingsBody
      narrow
      header={
        <SettingsHeader
          title="EA"
          description={`The assistant in the status bar and the EA chat. ${CALL_SHORTCUT.label} starts or ends a call.`}
        />
      }
    >
      <div className="space-y-4">
        {need !== null && (
          <div className="border border-border bg-card text-xs [&>section]:border-b-0">
            <SetupCard need={need} onCheck={refresh} />
          </div>
        )}
        <SettingsCard title="Audio">
          <SettingRow
            label="Microphone"
            stack
            description={
              <>
                What the EA hears. Kept per browser.
                <DeviceNotes kind="mic" />
              </>
            }
          >
            <MicPicker />
          </SettingRow>
          <SettingRow label="Mic level" stack description="The input level of the chosen microphone.">
            <MicTest />
          </SettingRow>
          <SettingRow
            label="Mic processing"
            stack
            description="Echo cancellation, noise suppression and auto gain. A live call switches at once."
          >
            <ProcessingToggles />
          </SettingRow>
          <SettingRow
            label="Speaker"
            stack
            description={
              <>
                Where the EA&apos;s voice plays.
                <DeviceNotes kind="speaker" />
              </>
            }
          >
            <SpeakerPicker />
            <TestSpeaker />
          </SettingRow>
          <SettingRow label="EA voice" description="Silences the EA until you turn it back on; it still hears you.">
            <ToggleButton
              pressed={call.outputMuted}
              onPressedChange={store.setOutputMuted}
              icon={VolumeX}
              label="Mute EA"
              hint="Mute the EA's voice in this browser"
            />
          </SettingRow>
        </SettingsCard>
        <SettingsCard title="Wake word">
          <p className="border-b border-border px-3 py-2 text-muted-foreground">
            With Wake word on, the EA only answers after its phrase and stays awake for the seconds after each exchange.
            Asleep, it listens for the phrase on its own host, so no audio goes to speech to text. Join on open connects
            the call asleep whenever Seti opens.
          </p>
          <WakeSetting className="flex-wrap border-t-0 py-3" state={settings} />
        </SettingsCard>
        <SettingsCard title="Manner">
          <SettingRow
            label="Address as"
            stack
            description="A title or name the EA uses now and then, such as sir, ma'am or your first name. Empty means none."
          >
            <AddressSetting state={settings} />
          </SettingRow>
        </SettingsCard>
        <SettingsCard title="Connection">
          <SettingRow label="Voice model" description="The language model behind the voice.">
            <span>{health?.model ?? '-'}</span>
          </SettingRow>
          <SettingRow label="Chat model" description="The language model behind the typed chat, EA_TEXT_MODEL.">
            <span>{health?.text_model ?? health?.model ?? '-'}</span>
          </SettingRow>
          <SettingRow
            label="Call relay"
            description="TURN relays calls that cannot connect directly; STUN only cannot."
          >
            <span>{relayText(health)}</span>
          </SettingRow>
          <SettingRow label="Reply time" description="From you going quiet to the EA speaking, on the last call.">
            <span>{latencyText(call.signals.latency)}</span>
          </SettingRow>
          <SettingRow label="Last end" description="How the last call in this browser ended.">
            <span data-testid="ea-last-end">{lastEndText(call.lastEnd)}</span>
          </SettingRow>
          <SettingRow label="Relay test" stack description="Checks that this browser can reach the relay.">
            <RelayCheck />
          </SettingRow>
        </SettingsCard>
        <UsageCard />
        <LiveContextCard />
      </div>
    </SettingsBody>
  )
}
