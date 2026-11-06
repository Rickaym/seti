import type { CodeLanguage } from '@seti/shared'
import { numberedText } from './code.js'
import { noteLine, plural, type RenderedPreview } from './preview.js'

/** Data formats by extension, with the language they highlight as and the name they show. */
export const DATA_FORMATS: Readonly<Record<string, { language: CodeLanguage; name: string }>> = {
  json: { language: 'json', name: 'JSON' },
  geojson: { language: 'json', name: 'GeoJSON' },
  jsonl: { language: 'json', name: 'JSON Lines' },
  ndjson: { language: 'json', name: 'JSON Lines' },
  yaml: { language: 'yaml', name: 'YAML' },
  yml: { language: 'yaml', name: 'YAML' },
  toml: { language: 'toml', name: 'TOML' },
}

/** Pretty JSON parses at most this much; larger files show as they are written. */
const PRETTY_MAX = 4 * 1024 * 1024

/** The JSON indented two spaces a level, or null when it does not parse. */
function pretty(text: string): string | null {
  if (text.length > PRETTY_MAX) {
    return null
  }
  try {
    return JSON.stringify(JSON.parse(text), null, 2)
  } catch {
    return null
  }
}

const records = (text: string) => text.split('\n').filter((line) => line.trim() !== '').length

const joined = (parts: readonly (string | null)[]) => {
  const kept = parts.filter((part) => part !== null)
  return kept.length === 0 ? null : kept.join(', ')
}

/** JSON indented and highlighted, JSON Lines, YAML and TOML highlighted as written. */
export async function dataPreview(extension: string, content: Buffer): Promise<RenderedPreview> {
  const format = DATA_FORMATS[extension] ?? { language: 'json', name: 'JSON' }
  const text = content.toString('utf8').replace(/^\uFEFF/, '')
  if (format.language === 'json' && format.name !== 'JSON Lines') {
    const indented = pretty(text)
    const shown = await numberedText(indented ?? text, indented === null ? null : 'json', false)
    const invalid = indented === null ? 'not valid JSON, shown as text' : null
    const note = joined([invalid, shown.note])
    return { body: noteLine(note) + shown.html, label: format.name, note, error: null, thumb: null }
  }
  const shown = await numberedText(text, format.language, false)
  const label = format.name === 'JSON Lines' ? `JSON Lines, ${plural(records(text), 'record')}` : format.name
  return { body: noteLine(shown.note) + shown.html, label, note: shown.note, error: null, thumb: null }
}
