import type { ModFileViewProps } from '@seti/mod-api'

/** The sample's notes viewer, loaded as its own chunk the first time a note opens. */
export function NotesView({ name, text, size, theme }: ModFileViewProps) {
  return (
    <div className="p-4 text-sm">
      <p className="font-semibold">Sample notes: {name}</p>
      <p className="text-muted-foreground">
        {size} bytes, {theme.dark ? 'dark' : 'light'} theme
      </p>
      <pre className="whitespace-pre-wrap">{(text ?? '').toUpperCase()}</pre>
    </div>
  )
}
