/** What Seti sends a view: where it is shown, the theme and, for viewers, the file. */
export interface ViewContext {
  mod: string
  view: string
  place: string
  phone: boolean
  agentId?: string
  file?: { name: string; size: number }
}

export interface ViewTheme {
  scheme: 'light' | 'dark'
  vars: Record<string, string>
  font: { sans: string; mono: string }
}

/**
 * `window.seti` inside a view, provided by the shim Seti injects first. Views need no bundle:
 * this file is types only. A view reaches only its mod's own commands, storage and settings.
 */
export interface SetiView {
  ready: () => void
  run: (command: string, args?: Record<string, unknown>) => Promise<unknown>
  storage: {
    get: (key: string) => Promise<unknown>
    keys: (prefix?: string) => Promise<string[]>
    set: (key: string, value: unknown) => Promise<void>
    delete: (key: string) => Promise<void>
  }
  settings: { get: () => Promise<Record<string, unknown>> }
  on: {
    (event: 'context', fn: (context: ViewContext) => void): void
    (event: 'theme', fn: (theme: ViewTheme) => void): void
    (event: 'file', fn: (file: { name: string; text?: string; base64?: string }) => void): void
    (event: 'storage', fn: (change: { key: string }) => void): void
  }
  resize: (height: number) => void
  open: (route: string) => void
  link: (url: string) => void
}
