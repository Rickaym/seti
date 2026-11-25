import type { Completion, CompletionContext, CompletionResult } from '@codemirror/autocomplete'
import { contextAt } from './json-scan'

/** The parts of a JSON Schema that completion reads. */
export interface JsonSchema {
  type?: string | string[]
  description?: string
  properties?: Record<string, JsonSchema>
  additionalProperties?: JsonSchema | boolean
  anyOf?: JsonSchema[]
  oneOf?: JsonSchema[]
  enum?: unknown[]
  const?: unknown
  readOnly?: boolean
}

const options = (schema: JsonSchema): JsonSchema[] => [schema, ...(schema.anyOf ?? []), ...(schema.oneOf ?? [])]

/** The schemas that may hold the value at a path, every branch of a union included. */
export function schemasAt(schema: JsonSchema, path: readonly string[]): JsonSchema[] {
  let at = options(schema)
  for (const key of path) {
    at = at.flatMap((node) => {
      const named = node.properties?.[key]
      if (named !== undefined) {
        return options(named)
      }
      const rest = node.additionalProperties
      return typeof rest === 'object' ? options(rest) : []
    })
  }
  return at
}

function keyOptions(schemas: JsonSchema[], present: ReadonlySet<string>): Completion[] {
  const seen = new Map<string, JsonSchema>()
  for (const node of schemas) {
    for (const [key, child] of Object.entries(node.properties ?? {})) {
      if (!present.has(key) && !seen.has(key)) {
        seen.set(key, child)
      }
    }
  }
  return [...seen].map(([key, child]) => ({
    label: JSON.stringify(key),
    apply: `${JSON.stringify(key)}: `,
    type: 'property',
    ...(child.description === undefined ? {} : { info: child.description }),
  }))
}

function valueOptions(schemas: JsonSchema[]): Completion[] {
  const values = new Set<string>()
  for (const node of schemas) {
    for (const value of [...(node.enum ?? []), ...('const' in node ? [node.const] : [])]) {
      values.add(JSON.stringify(value))
    }
    const types = Array.isArray(node.type) ? node.type : [node.type]
    if (types.includes('boolean')) {
      values.add('true')
      values.add('false')
    }
    if (types.includes('null')) {
      values.add('null')
    }
  }
  return [...values].map((label) => ({ label, type: 'constant' }))
}

/** The keys the object at a path already has, so completion offers only the others. */
function keysPresent(path: readonly string[], keys: { path: string[] }[]): Set<string> {
  const depth = path.length
  const prefix = path.join('\u0000')
  return new Set(
    keys
      .filter((key) => key.path.length === depth + 1 && key.path.slice(0, depth).join('\u0000') === prefix)
      .map((key) => key.path.at(-1) ?? ''),
  )
}

/** Completes keys, with their descriptions, and values the served JSON Schema allows. */
export function schemaCompletion(schema: JsonSchema, spans: (text: string) => { path: string[] }[]) {
  return (context: CompletionContext): CompletionResult | null => {
    const text = context.state.doc.toString()
    const at = contextAt(text, context.pos)
    if (at === null || (at.from === context.pos && !context.explicit)) {
      return null
    }
    const schemas = schemasAt(schema, at.path)
    const list = at.kind === 'key' ? keyOptions(schemas, keysPresent(at.path, spans(text))) : valueOptions(schemas)
    return list.length === 0 ? null : { from: at.from, options: list, validFor: /^"?[\w .-]*"?$/ }
  }
}
