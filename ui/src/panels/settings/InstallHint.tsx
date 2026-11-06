import { BellRing, Share, SquarePlus, type LucideIcon } from 'lucide-react'
import { SettingsCard } from './layout'

const STEPS: readonly [LucideIcon, string][] = [
  [Share, 'In Safari, tap Share; on iOS 26 it is in the More menu.'],
  [SquarePlus, 'Choose Add to Home Screen, then Add.'],
  [BellRing, 'Open Seti from the Home Screen and turn on Push here.'],
]

/** Safari on iPhone and iPad gives push only to the Home Screen app, so this says how to add it. */
export function InstallHint() {
  return (
    <SettingsCard title="Add to Home Screen">
      <p className="px-3 pt-2.5 text-muted-foreground">
        On iPhone and iPad, notifications reach Seti only once it is on the Home Screen.
      </p>
      <ol className="space-y-2 px-3 py-2.5">
        {STEPS.map(([Icon, text]) => (
          <li key={text} className="flex items-center gap-2">
            <Icon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
            <span>{text}</span>
          </li>
        ))}
      </ol>
    </SettingsCard>
  )
}
