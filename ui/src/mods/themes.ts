import { modScoped, type Disposer, type ModManifest, type ModTheme } from '@seti/shared'
import { themeRegistry, type ThemeDefinition, type ThemeOptions } from '@/components/theme/registry'
import { THEME_TOKENS } from './bundled'

const cssColour = (swatch: string) => (swatch.startsWith('--') ? `var(${swatch})` : swatch)

function optionsOf(choice: ModTheme['flavours']): ThemeOptions | undefined {
  if (choice === undefined) {
    return undefined
  }
  const options = choice.options.map((option) => ({
    id: option.id,
    label: option.title,
    swatch: cssColour(option.swatch),
  }))
  return { options, fallback: choice.fallback }
}

/** A theme as the manifest declares it, named `<mod>.<theme>` like everything a mod adds. */
export function themeOf(mod: string, theme: ModTheme): ThemeDefinition {
  const [first = 'light', ...rest] = theme.schemes
  const definition: ThemeDefinition = {
    id: modScoped(mod, theme.id),
    label: theme.title,
    description: theme.description ?? theme.title,
    schemes: [first, ...rest],
    swatch: theme.swatch,
  }
  const flavours = optionsOf(theme.flavours)
  const accents = optionsOf(theme.accents)
  return {
    ...definition,
    ...(flavours === undefined ? {} : { flavours }),
    ...(accents === undefined ? {} : { accents }),
  }
}

/** Offers the mod's themes in the picker while it runs. */
export function registerThemes(manifest: ModManifest, track: (dispose: Disposer) => Disposer): void {
  for (const theme of manifest.contributes.themes) {
    track(themeRegistry.register(themeOf(manifest.id, theme)))
  }
}

/** Adds every theme mod's tokens to the page once; each applies only while its theme is shown. */
export function installThemeTokens(head: Pick<HTMLElement, 'append'> = document.head): void {
  for (const [mod, css] of Object.entries(THEME_TOKENS)) {
    const style = document.createElement('style')
    style.dataset.modTokens = mod
    style.textContent = css
    head.append(style)
  }
}
