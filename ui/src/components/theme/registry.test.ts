import { disposeAll, modManifest, type Disposer } from '@seti/shared'
import { afterEach, describe, expect, it } from 'vitest'
import { registerThemes } from '@/mods/themes'
import { choiceFor, resolveTheme, schemeFor, themeRegistry, type ThemeDefinition } from './registry'
import { legacyChoice } from './theme-choice'

const manifest = (themes: unknown[]) =>
  modManifest.parse({
    id: 'pastel',
    name: 'Pastel',
    version: '1.0.0',
    seti: '^1.0',
    description: 'Soft colours',
    contributes: { themes },
  })

const PASTEL = {
  id: 'soft',
  title: 'Soft',
  tokens: 'tokens.css',
  swatch: {
    light: { background: '#ffffff', primary: '#884488', foreground: '#111111' },
    dark: { background: '#111111', primary: '#cc99cc', foreground: '#eeeeee' },
  },
  flavours: {
    options: [
      { id: 'dusk', title: 'Dusk', swatch: '#222233' },
      { id: 'night', title: 'Night', swatch: '#111122' },
    ],
    fallback: 'night',
  },
  accents: { options: [{ id: 'rose', title: 'Rose', swatch: '--pastel-rose' }], fallback: 'rose' },
}

const disposers: Disposer[] = []

const turnOn = (themes: unknown[] = [PASTEL]) => {
  registerThemes(manifest(themes), (dispose) => {
    disposers.push(dispose)
    return dispose
  })
}

afterEach(() => {
  disposeAll(disposers)
})

const choice = (id: string, flavour: string | null = null, accent: string | null = null) => ({ id, flavour, accent })

describe('the theme registry', () => {
  it('always holds the default theme', () => {
    expect(themeRegistry.list().map((theme) => theme.id)).toEqual(['default'])
  })

  it("offers a mod's themes as <mod>.<theme> while it runs, and drops them when it stops", () => {
    turnOn()
    const soft = themeRegistry.get('pastel.soft')
    expect(soft).toMatchObject({ label: 'Soft', description: 'Soft', schemes: ['light', 'dark'] })
    expect(soft?.flavours?.options.map((option) => option.id)).toEqual(['dusk', 'night'])
    expect(soft?.accents?.options[0]?.swatch).toBe('var(--pastel-rose)')
    disposeAll(disposers)
    expect(themeRegistry.has('pastel.soft')).toBe(false)
  })

  it('refuses a theme schema whose swatch misses a scheme it lists', () => {
    expect(() => manifest([{ ...PASTEL, swatch: { light: PASTEL.swatch.light } }])).toThrow(/swatch per scheme/)
    expect(() => manifest([{ ...PASTEL, schemes: ['light'], swatch: { light: PASTEL.swatch.light } }])).not.toThrow()
  })
})

describe('resolveTheme', () => {
  it('shows the default for no choice', () => {
    expect(resolveTheme(null)).toMatchObject({ theme: { id: 'default' }, flavour: null, accent: null })
  })

  it("falls back to the default while the chosen theme's mod is off, and returns once it is on", () => {
    const chosen = choice('pastel.soft', 'dusk', 'rose')
    expect(resolveTheme(chosen)).toMatchObject({ theme: { id: 'default' }, flavour: null, accent: null })
    turnOn()
    expect(resolveTheme(chosen)).toMatchObject({ theme: { id: 'pastel.soft' }, flavour: 'dusk', accent: 'rose' })
    disposeAll(disposers)
    expect(resolveTheme(chosen).theme.id).toBe('default')
  })

  it('takes the fallback of an option the theme does not offer', () => {
    turnOn()
    expect(resolveTheme(choice('pastel.soft', 'mocha', 'teal'))).toMatchObject({ flavour: 'night', accent: 'rose' })
  })
})

describe('schemeFor and choiceFor', () => {
  const pinned: ThemeDefinition['schemes'] = ['dark']

  it('keeps the wanted scheme when the theme offers it, else the first it has', () => {
    expect(schemeFor(['light', 'dark'], 'light')).toBe('light')
    expect(schemeFor(pinned, 'light')).toBe('dark')
    expect(schemeFor([], 'light')).toBe('light')
  })

  it('keeps a stored option the theme offers and falls back otherwise', () => {
    turnOn()
    const soft = themeRegistry.get('pastel.soft')
    expect(choiceFor(soft?.flavours, 'dusk')).toBe('dusk')
    expect(choiceFor(soft?.flavours, 'latte')).toBe('night')
    expect(choiceFor(soft?.flavours, null)).toBe('night')
    expect(choiceFor(undefined, 'dusk')).toBeNull()
  })
})

describe('legacyChoice', () => {
  const stored = (values: Record<string, string>) => (key: string) => values[key] ?? null

  it('names the theme a browser kept as the mod that has it now', () => {
    turnOn()
    const kept = stored({ 'seti-ui-theme-id': 'soft', 'seti-ui-theme-flavour': 'dusk', 'seti-ui-theme-accent': 'rose' })
    expect(legacyChoice(kept)).toEqual(choice('pastel.soft', 'dusk', 'rose'))
    expect(legacyChoice(stored({ 'seti-ui-theme-id': 'default' }))).toEqual(choice('default'))
  })

  it('moves nothing when the browser kept nothing or a theme no mod has', () => {
    expect(legacyChoice(stored({}))).toBeNull()
    expect(legacyChoice(stored({ 'seti-ui-theme-id': 'soft' }))).toBeNull()
  })
})
