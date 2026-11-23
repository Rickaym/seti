import { Hono } from 'hono'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fail } from './http.js'
import { logServerErrors } from './server-errors.js'

const TOKEN = `ghp_${'a1B2c3D4'.repeat(4)}`

function testApp(): Hono {
  const app = new Hono()
  app.onError((e, c) => fail(c, 500, 'Server error', e.message))
  app.use('*', logServerErrors)
  app.get('/api/tasks/:id/messages', () => {
    throw new TypeError(`cannot read rows\nsecond line ${TOKEN}`)
  })
  app.post('/api/tokens', () => {
    throw new Error(`refused ${TOKEN} for this host`)
  })
  app.get('/api/upstream', (c) => fail(c, 502, 'Bad gateway'))
  app.get('/api/missing', (c) => fail(c, 404, 'Not found'))
  app.route(
    '/api/prs',
    new Hono().get('/:number', () => {
      throw new RangeError('no such pr')
    }),
  )
  return app
}

const spyLog = () => vi.spyOn(process.stderr, 'write').mockReturnValue(true)

const logged = (spy: ReturnType<typeof spyLog>): string[] =>
  spy.mock.calls.map(([chunk]) => String(chunk)).filter((line) => line.startsWith('server error:'))

describe('logServerErrors', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('logs a handler that throws on a GET by route pattern, status and first message line', async () => {
    const spy = spyLog()
    const res = await testApp().request('/api/tasks/t-1/messages?wire=events&before=secret-cursor')
    expect(res.status).toBe(500)
    expect(logged(spy)).toEqual(['server error: GET /api/tasks/:id/messages 500 TypeError: cannot read rows\n'])
  })

  it('redacts a secret-looking value in the error before it reaches the log', async () => {
    const spy = spyLog()
    await testApp().request('/api/tokens', { method: 'POST', body: JSON.stringify({ value: TOKEN }) })
    const [line] = logged(spy)
    expect(line).toMatch(/^server error: POST \/api\/tokens 500 Error: refused .+ for this host\n$/)
    expect(line).not.toContain(TOKEN)
  })

  it('logs a 5xx answered without a throw and leaves other answers out', async () => {
    const spy = spyLog()
    const app = testApp()
    await app.request('/api/upstream')
    await app.request('/api/missing')
    expect(logged(spy)).toEqual(['server error: GET /api/upstream 502 answered without a thrown error\n'])
  })

  it('names the full pattern of a route mounted from a sub-app', async () => {
    const spy = spyLog()
    await testApp().request('/api/prs/42')
    expect(logged(spy)).toEqual(['server error: GET /api/prs/:number 500 RangeError: no such pr\n'])
  })
})
