import { Hint } from '@/components/Hint'
import { ToggleButton } from '@/components/ToggleButton'
import { schemeFor, useThemes, type Swatch, type ThemeDefinition } from '@/components/theme/registry'
import { useTheme } from '@/components/theme/theme-context'
import { cn } from '@/lib/utils'
import { SettingRow } from './layout'

/** The shown theme's own tokens, so its swatch follows the flavour and accent chosen. */
const LIVE: Swatch = { background: 'var(--background)', primary: 'var(--primary)', foreground: 'var(--foreground)' }

/** Background, accent and text of a theme in the current scheme. */
function ThemeSwatch({ theme, shown }: { theme: ThemeDefinition; shown: boolean }) {
  const { scheme } = useTheme()
  const swatch = shown ? LIVE : theme.swatch[schemeFor(theme.schemes, scheme)]
  return (
    <span aria-hidden className="flex size-4 shrink-0 overflow-hidden border border-border">
      {(['background', 'primary', 'foreground'] as const).map((part) => (
        <span key={part} className="h-full flex-1" style={{ background: swatch?.[part] }} />
      ))}
    </span>
  )
}

const Dot = ({ colour }: { colour: string }) => (
  <span aria-hidden className="size-4 shrink-0 rounded-full border border-border" style={{ background: colour }} />
)

/** The theme picker: Seti's own theme and each one an enabled mod adds, with its choices. */
export function ThemeChoices() {
  const { themeId, setThemeId, flavour, setFlavour, accent, setAccent } = useTheme()
  const themes = useThemes()
  const theme = themes.find((entry) => entry.id === themeId)
  return (
    <>
      <SettingRow label="Theme" stack description="Every device shows it. Mods add themes; each has light and dark.">
        <div role="group" aria-label="Theme" className="flex flex-wrap items-center gap-1.5">
          {themes.map((entry) => (
            <ToggleButton
              key={entry.id}
              pressed={themeId === entry.id}
              onPressedChange={() => {
                setThemeId(entry.id)
              }}
              icon={<ThemeSwatch theme={entry} shown={themeId === entry.id} />}
              label={entry.label}
              hint={entry.description}
            />
          ))}
        </div>
      </SettingRow>
      {theme?.flavours && (
        <SettingRow label="Dark flavour" stack description="The palette for dark mode.">
          <div role="group" aria-label="Dark flavour" className="flex flex-wrap items-center gap-1.5">
            {theme.flavours.options.map((option) => (
              <ToggleButton
                key={option.id}
                pressed={flavour === option.id}
                onPressedChange={() => {
                  setFlavour(option.id)
                }}
                icon={<Dot colour={option.swatch} />}
                label={option.label}
                hint={`${option.label} in dark mode`}
              />
            ))}
          </div>
        </SettingRow>
      )}
      {theme?.accents && (
        <SettingRow label="Accent" stack description="Colours buttons, links, focus rings and selections.">
          <div role="group" aria-label="Accent" className="flex flex-wrap items-center gap-1">
            {theme.accents.options.map((option) => (
              <Hint key={option.id} text={option.label}>
                <button
                  type="button"
                  aria-label={option.label}
                  aria-pressed={accent === option.id}
                  onClick={() => {
                    setAccent(option.id)
                  }}
                  className={cn(
                    'flex size-7 items-center justify-center border border-transparent outline-none hover:border-border focus-visible:ring-2 focus-visible:ring-ring',
                    'aria-pressed:border-foreground pointer-coarse:size-11',
                  )}
                >
                  <span
                    aria-hidden
                    className="size-4 rounded-full pointer-coarse:size-6"
                    style={{ background: option.swatch }}
                  />
                </button>
              </Hint>
            ))}
          </div>
        </SettingRow>
      )}
    </>
  )
}
