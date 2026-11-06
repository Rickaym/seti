import { modManifest, type ModTheme } from '@seti/shared'
import { describe, expect, it } from 'vitest'
import { themeTokensCss } from './theme-tokens.js'

const theme: ModTheme =
  modManifest.parse({
    id: 'dusk',
    name: 'Dusk',
    version: '1.0.0',
    seti: '^1.8',
    description: 'A theme',
    contributes: {
      themes: [
        {
          id: 'night',
          title: 'Night',
          tokens: 'tokens.css',
          swatch: {
            light: { background: '#ffffff', primary: '#2a4a8a', foreground: '#111111' },
            dark: { background: '#0d1320', primary: '#8fb0ff', foreground: '#e8ecf4' },
          },
        },
      ],
    },
  }).contributes.themes[0] ?? expect.fail('no theme')

const checked = (css: string) => themeTokensCss('dusk', theme, css)

describe('third-party theme tokens', () => {
  it('rebuilds colour tokens under its own selectors, comments and spacing dropped', () => {
    const css = `/* light */
:root[data-theme='dusk.night'] { --background: #fff; --primary: var(--dusk-blue); --radius: 0.5rem; }
:root[data-theme='dusk.night'].dark[data-accent='blue'] {
  --border: color-mix(in srgb, var(--foreground) 15%, transparent);
  --ring: oklch(0.7 0.1 250 / 50%);
}`
    expect(checked(css)).toEqual({
      css: [
        ":root[data-theme='dusk.night'] {\n  --background: #fff;\n  --primary: var(--dusk-blue);\n  --radius: 0.5rem;\n}",
        ":root[data-theme='dusk.night'].dark[data-accent='blue'] {\n" +
          '  --border: color-mix(in srgb, var(--foreground) 15%, transparent);\n' +
          '  --ring: oklch(0.7 0.1 250 / 50%);\n}',
      ].join('\n'),
    })
  })

  it.each([
    ['a URL that would load from the web', ":root[data-theme='dusk.night'] { --background: url(https://evil.test/x) }"],
    ['a property that is not a token', ":root[data-theme='dusk.night'] { display: none; }"],
    ['a value that smuggles a second declaration', ":root[data-theme='dusk.night'] { --a: red; background: url(x) }"],
    ['a rule for every page', 'body { --background: #000; }'],
    ['the theme of another mod', ":root[data-theme='seti.default'] { --background: #000; }"],
    ['an element selector after the theme', ":root[data-theme='dusk.night'] button { --background: #000; }"],
    ['an at-rule', "@import url(x); :root[data-theme='dusk.night'] { --a: #000; }"],
    ['a nested block', ":root[data-theme='dusk.night'] { --a: #000; { --b: #fff } }"],
    ['text after the last rule', ":root[data-theme='dusk.night'] { --a: #000; } x"],
    ['a length on a colour token', ":root[data-theme='dusk.night'] { --background: 10px; }"],
    ['an escaped name', ":root[data-theme='dusk.night'] { --a\\62: #000; }"],
  ])('refuses %s', (_name, css) => {
    expect(checked(css)).toHaveProperty('problem')
  })
})
