const FIELD_LABELS: Record<string, string> = {
  name: 'Name',
  description: 'Description',
  body: 'Content',
  content: 'Content',
}

export const fieldLabel = (key: string) => FIELD_LABELS[key] ?? key
