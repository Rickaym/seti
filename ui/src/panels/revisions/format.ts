const FIELD_LABELS: Record<string, string> = {
  name: 'Name',
  description: 'Description',
  body: 'Content',
  content: 'Content',
}

/** A field's name; a settings revision's keys are JSON Pointers, shown as dotted paths. */
export const fieldLabel = (key: string) =>
  FIELD_LABELS[key] ??
  (key.startsWith('/') ? key.slice(1).replaceAll('/', '.').replaceAll('~1', '/').replaceAll('~0', '~') : key)
