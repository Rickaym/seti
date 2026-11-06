import { nextRunTimes, scheduleIssue, type CronSchedule } from '@seti/shared'
import { useRef, useState } from 'react'
import { Field } from '@/components/crud/CrudForm'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { CUSTOM, describeSchedule, formatWhen, presetFor, SCHEDULE_PRESETS } from './cron'

const PREVIEW_RUNS = 3

/** The schedule in words and its next runs in local time, or why it cannot be used. */
function SchedulePreview({ schedule }: { schedule: CronSchedule }) {
  const issue = scheduleIssue(schedule.cron, schedule.timezone)
  if (issue !== null) {
    return <p className="text-xs text-destructive">{issue.message}</p>
  }
  const next = nextRunTimes(schedule.cron, schedule.timezone, PREVIEW_RUNS)
  return (
    <div className="space-y-0.5 text-xs" data-testid="schedule-preview">
      <p className="text-foreground">
        {describeSchedule(schedule.cron)} ({schedule.timezone})
      </p>
      <p className="text-muted-foreground">Next, in your local time: {next.map(formatWhen).join('  |  ')}</p>
    </div>
  )
}

/** A cron schedule: a preset or a custom expression, its timezone and a preview of its next runs. */
export function CronFields({ value, onChange }: { value: CronSchedule; onChange: (next: CronSchedule) => void }) {
  const [custom, setCustom] = useState(() => presetFor(value.cron) === CUSTOM)
  const cronInput = useRef<HTMLInputElement>(null)
  const focusCron = useRef(false)

  return (
    <>
      <Field label="Schedule">
        <Select
          value={custom ? CUSTOM : presetFor(value.cron)}
          onValueChange={(picked) => {
            focusCron.current = picked === CUSTOM
            setCustom(picked === CUSTOM)
            if (picked !== CUSTOM) {
              onChange({ ...value, cron: picked })
            }
          }}
        >
          <SelectTrigger aria-label="Schedule" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent
            onCloseAutoFocus={(event) => {
              if (focusCron.current) {
                event.preventDefault()
                focusCron.current = false
                requestAnimationFrame(() => cronInput.current?.focus())
              }
            }}
          >
            {SCHEDULE_PRESETS.map((preset) => (
              <SelectItem key={preset.cron} value={preset.cron}>
                {preset.label}
              </SelectItem>
            ))}
            <SelectItem value={CUSTOM}>Custom cron</SelectItem>
          </SelectContent>
        </Select>
      </Field>
      <Field label="Timezone">
        <Input
          aria-label="Timezone"
          value={value.timezone}
          onChange={(e) => {
            onChange({ ...value, timezone: e.target.value })
          }}
          placeholder="Europe/Berlin"
        />
      </Field>
      {custom && (
        <Field label="Cron (minute hour day month weekday)" full>
          <Input
            ref={cronInput}
            aria-label="Cron"
            value={value.cron}
            onChange={(e) => {
              onChange({ ...value, cron: e.target.value })
            }}
            placeholder="*/30 9-18 * * 1-5"
          />
        </Field>
      )}
      <div className="col-span-full border border-border bg-muted/40 px-3 py-2">
        <SchedulePreview schedule={value} />
      </div>
    </>
  )
}
