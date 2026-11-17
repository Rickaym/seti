import {
  connectionTemplate,
  expandTemplate,
  templateValues,
  type Connection,
  type ConnectionTemplateRequest,
} from '@seti/shared'
import { createConnections } from './connections.js'
import { HttpError } from './http.js'
import { connectionRows } from './store/connections.js'

/** Adds the connections of a filled-in template, all or none, under names nothing else uses. */
export async function createFromTemplate(input: ConnectionTemplateRequest): Promise<Connection[]> {
  const template = connectionTemplate(input.template)
  if (template === undefined) {
    throw new HttpError(404, 'No such template')
  }
  const rows = await connectionRows.list()
  const taken = { names: new Set(rows.map((row) => row.name)), envs: new Set(rows.map((row) => row.env)) }
  const expanded = expandTemplate(template, input, taken)
  if ('error' in expanded) {
    throw new HttpError(400, expanded.error)
  }
  const values = templateValues(template, input.values)
  if ('error' in values) {
    throw new HttpError(400, values.error)
  }
  return createConnections(
    expanded.connections.map((connection) => ({ ...connection, values, profile_ids: input.profile_ids })),
    template.id,
  )
}
