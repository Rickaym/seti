import { expect, type APIRequestContext } from '@playwright/test'

const KEY_CONNECTION = 'e2e_gemini'

/** Puts a Gemini API key with a dummy value in the default credential, as the user would. */
export async function geminiKey(request: APIRequestContext): Promise<void> {
  const response = await request.post('/api/connections', {
    data: {
      name: KEY_CONNECTION,
      kind: 'key',
      env: 'E2E_GEMINI',
      hosts: ['generativelanguage.googleapis.com'],
      header: { name: 'x-goog-api-key', template: '{{value}}' },
      values: { value: 'e2e-not-a-key' },
      profile_ids: ['default'],
    },
  })
  expect(response.ok(), 'POST /api/connections').toBe(true)
}

/** Turns Gemini off with its defaults, which removes Seti's copy, and drops the key. */
export async function geminiOff(request: APIRequestContext): Promise<void> {
  const listed = (await (await request.get('/api/connections')).json()) as { data: { id: string; name: string }[] }
  for (const each of listed.data.filter((connection) => connection.name === KEY_CONNECTION)) {
    await request.delete(`/api/connections/${each.id}`)
  }
  const response = await request.put('/api/runtimes/gemini', {
    data: { enabled: false, evaluator_decides: true, default_model: null },
  })
  expect(response.ok(), 'PUT /api/runtimes/gemini').toBe(true)
}
