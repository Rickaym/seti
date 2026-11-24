/** The JSON Schema fields the settings document tests walk. */
export interface JsonSchema {
  description?: string
  properties?: Record<string, JsonSchema>
  anyOf?: JsonSchema[]
  additionalProperties?: JsonSchema | boolean
  items?: JsonSchema
}

/** Every property path of a JSON Schema that has no description. */
export function undocumented(schema: JsonSchema, path = ''): string[] {
  const values = typeof schema.additionalProperties === 'object' ? [schema.additionalProperties] : []
  const inner = [...(schema.anyOf ?? []), ...values, ...(schema.items === undefined ? [] : [schema.items])]
  const nested = inner.flatMap((option) => undocumented(option, `${path}.*`))
  const own = Object.entries(schema.properties ?? {}).flatMap(([key, child]) => {
    const at = path === '' ? key : `${path}.${key}`
    return [...(child.description === undefined ? [at] : []), ...undocumented(child, at)]
  })
  return [...own, ...nested]
}
