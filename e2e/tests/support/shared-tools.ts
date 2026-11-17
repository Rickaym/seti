import { createHash } from 'node:crypto'
import type { APIRequestContext } from '@playwright/test'
import type { SharedTool, SharedToolCode } from '@seti/shared'
import { seedChangeRequest } from './change-requests.js'
import { apiData, unique } from './fixtures.js'

export const TOOL_DESCRIPTION = 'Use it to list the open invoices of a customer: run it with the customer id.'

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')

/** A proposal as request_change stores it: the agent's fields and the script Seti read. */
export async function seedToolProposal(content: string, replaces: SharedToolCode | null = null) {
  const name = replaces?.name ?? unique('invoices')
  const change = {
    kind: 'shared_tool',
    name,
    description: TOOL_DESCRIPTION,
    path: 'invoices.py',
    needs: [{ env: 'BILLING_KEY', hosts: ['api.billing.example.com'] }],
    snapshot: {
      file: 'invoices.py',
      content,
      sha256: sha256(content),
      replaces: replaces === null ? null : { sha256: replaces.sha256, content: replaces.content },
    },
  }
  const seeded = await seedChangeRequest(
    change,
    `Asks for the shared tool ${name}`,
    'Other agents keep asking me to look invoices up for them.',
  )
  return { ...seeded, name, hash: change.snapshot.sha256 }
}

export const sharedTool = async (request: APIRequestContext, name: string) =>
  (await apiData<SharedTool[]>(request, '/shared-tools')).find((tool) => tool.name === name)
