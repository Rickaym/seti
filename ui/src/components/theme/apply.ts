import type { Scheme } from './registry'

/** What <html> carries for the active theme; null leaves the attribute off. */
export interface AppliedTheme {
  themeId: string
  scheme: Scheme
  flavour: string | null
  accent: string | null
}

interface Root {
  setAttribute: (name: string, value: string) => void
  removeAttribute: (name: string) => void
  classList: Pick<DOMTokenList, 'add' | 'remove'>
}

export function applyTheme(root: Root, applied: AppliedTheme): void {
  const attributes = { 'data-theme': applied.themeId, 'data-flavour': applied.flavour, 'data-accent': applied.accent }
  for (const [name, value] of Object.entries(attributes)) {
    if (value === null) {
      root.removeAttribute(name)
    } else {
      root.setAttribute(name, value)
    }
  }
  root.classList.remove('light', 'dark')
  root.classList.add(applied.scheme)
}
