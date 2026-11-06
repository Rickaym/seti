import { callbackUrlIssue, mcpAuthCompleteInput } from '@seti/shared'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HttpError } from './http.js'
import { createMcpAuth, findAuthorizationUrl, scrubOutput, type AuthTiming, type LoginProcess } from './mcp-auth.js'

const AUTH_URL = 'https://oauth.example.com/authorize?client_id=abc&state=s1&redirect_uri=http%3A%2F%2Flocalhost%3A1'
const CALLBACK = 'http://localhost:41234/callback?code=c1&state=s1'
const FAST: AuthTiming = { idleMs: 1000, callMs: 200 }
const link = (url: string) => `\u001b]8;;${url}\u0007${url}\u001b]8;;\u0007`
const OAUTH_BANNER = [
  'Starting authentication for "posthog"...\r\n',
  `Visit this URL to authorize:\r\n  ${link(AUTH_URL)}\r\n\r\n`,
  'Waiting for authorization... (^C to cancel)\r\nOr paste the redirect URL here: ',
]

class FakeLogin implements LoginProcess {
  readonly writes: string[] = []
  readonly kill = vi.fn()
  private readonly outputs: ((text: string) => void)[] = []
  private readonly exits: ((code: number) => void)[] = []

  private readonly script: (fake: FakeLogin) => void

  constructor(
    script: (fake: FakeLogin) => void = (fake) => {
      fake.emit(...OAUTH_BANNER)
    },
  ) {
    this.script = script
  }

  onOutput = (listener: (text: string) => void) => {
    this.outputs.push(listener)
    if (this.outputs.length === 1) {
      queueMicrotask(() => {
        this.script(this)
      })
    }
  }

  onExit = (listener: (code: number) => void) => {
    this.exits.push(listener)
  }

  write = (text: string) => {
    this.writes.push(text)
    this.onWrite(text)
  }

  onWrite: (text: string) => void = () => undefined

  emit(...chunks: string[]) {
    for (const chunk of chunks) {
      for (const listener of this.outputs) {
        listener(chunk)
      }
    }
  }

  exit(code: number) {
    for (const listener of this.exits) {
      listener(code)
    }
  }
}

function setup(fake = new FakeLogin(), timing: AuthTiming = FAST) {
  const spawn = vi.fn((_server: string, _cwd: string) => fake)
  const onClosed = vi.fn()
  return { auth: createMcpAuth(spawn, onClosed, timing), spawn, onClosed, fake }
}

const rejection = async (promise: Promise<unknown>) => {
  try {
    await promise
  } catch (e) {
    return e as HttpError
  }
  throw new Error('expected a rejection')
}

afterEach(() => {
  vi.useRealTimers()
})

describe('findAuthorizationUrl', () => {
  it('reads the OSC 8 hyperlink target, even across chunk boundaries once complete', () => {
    expect(findAuthorizationUrl(OAUTH_BANNER.join(''))).toBe(AUTH_URL)
    const full = OAUTH_BANNER.join('')
    expect(findAuthorizationUrl(full.slice(0, full.indexOf('client_id')))).toBeNull()
  })

  it('falls back to a plain URL followed by whitespace', () => {
    expect(findAuthorizationUrl(`Visit this URL to authorize:\n  ${AUTH_URL}\n`)).toBe(AUTH_URL)
    expect(findAuthorizationUrl(`Visit this URL to authorize:\n  ${AUTH_URL}`)).toBeNull()
  })

  it.each([
    ['no URL', 'Starting authentication\r\n'],
    ['http only', `${link('http://insecure.example.com/authorize?x=1')}\n`],
    ['other schemes', 'javascript:alert(1)\n'],
  ])('ignores %s', (_label, output) => {
    expect(findAuthorizationUrl(output)).toBeNull()
  })
})

describe('scrubOutput', () => {
  it('drops escapes, query strings, secret params and SDK noise', () => {
    const out = scrubOutput(
      [
        '\u001b[?25hOr paste the redirect URL here: http://localhost:1/callback?code=SECRET1&state=SECRET2\r\r\n',
        "[mcp-sdk] SEP-2352: stored OAuth credential has no 'issuer' stamp\r\n",
        'Error: invalid_grant code=SECRET3 token=SECRET4\r\n',
      ].join(''),
    )
    expect(out).toBe(
      'Or paste the redirect URL here: http://localhost:1/callback Error: invalid_grant code=[redacted] token=[redacted]',
    )
    expect(out).not.toMatch(/SECRET/)
  })
})

describe('callback URL validation', () => {
  it.each([
    CALLBACK,
    'http://127.0.0.1:5555/callback?state=s&code=c',
    '  http://localhost:1/callback?code=c&state=s  ',
  ])('accepts %s', (url) => {
    expect(mcpAuthCompleteInput.safeParse({ callback_url: url }).success).toBe(true)
  })

  it.each([
    ['', 'Paste the full address'],
    ['localhost:1/callback?code=c&state=s', 'must start with'],
    ['https://localhost:1/callback?code=c&state=s', 'must start with'],
    ['http://evil.example.com/callback?code=c&state=s', 'must start with'],
    // eslint-disable-next-line sonarjs/no-clear-text-protocols -- a lookalike host must be rejected
    ['http://localhost.evil.com/callback?code=c&state=s', 'must start with'],
    ['http://localhost:1/callback?code=c', 'no code and state'],
    ['http://localhost:1/callback?state=s', 'no code and state'],
  ])('rejects %j', (url, text) => {
    expect(callbackUrlIssue(url.trim())).toContain(text)
    expect(mcpAuthCompleteInput.safeParse({ callback_url: url }).success).toBe(false)
  })
})

describe('createMcpAuth', () => {
  it('spawns the login in the cwd and returns the authorization URL', async () => {
    const { auth, spawn, fake } = setup()
    const result = await auth.start('plugin:posthog:posthog', '/home/me')
    expect(spawn).toHaveBeenCalledWith('plugin:posthog:posthog', '/home/me')
    expect(result).toMatchObject({ authorization_url: AUTH_URL, callback_expected: true })
    expect(result.session_id).toMatch(/^[0-9a-f-]{36}$/)
    expect(fake.kill).not.toHaveBeenCalled()
  })

  it('writes the callback to the same process and succeeds on exit 0', async () => {
    const fake = new FakeLogin()
    fake.onWrite = () => {
      fake.emit('http://localhost:41234/callback?code=c1&state=s1\r\r\nAuthenticated with "posthog".\r\n')
      fake.exit(0)
    }
    const { auth, onClosed } = setup(fake)
    const { session_id } = await auth.start('posthog', '/home/me')
    await expect(auth.complete(session_id, CALLBACK)).resolves.toEqual({ server: 'posthog' })
    expect(fake.writes).toEqual([`${CALLBACK}\r`])
    expect(fake.kill).toHaveBeenCalledOnce()
    expect(onClosed).toHaveBeenCalledWith('/home/me')
    expect(auth.cancel(session_id)).toBe(false)
  })

  it('keeps the process when the CLI rejects the address, so the user can retry', async () => {
    const fake = new FakeLogin()
    fake.onWrite = (text) => {
      if (fake.writes.length === 1) {
        fake.emit(
          `${text}\r\nThat doesn't look like a redirect URL for this sign-in.\r\nOr paste the redirect URL here: `,
        )
      } else {
        fake.exit(0)
      }
    }
    const { auth } = setup(fake)
    const { session_id } = await auth.start('posthog', '/home/me')
    const error = await rejection(auth.complete(session_id, CALLBACK))
    expect(error.status).toBe(400)
    expect(error.message).toContain("doesn't look like a redirect URL")
    expect(fake.kill).not.toHaveBeenCalled()
    await expect(auth.complete(session_id, CALLBACK)).resolves.toEqual({ server: 'posthog' })
  })

  it('fails and closes on a non-zero exit, returning scrubbed output', async () => {
    const fake = new FakeLogin()
    fake.onWrite = () => {
      fake.emit(`${CALLBACK}\r\nCouldn't complete authentication: invalid_grant state=s1\r\n`)
      fake.exit(1)
    }
    const { auth, onClosed } = setup(fake)
    const { session_id } = await auth.start('posthog', '/home/me')
    const error = await rejection(auth.complete(session_id, CALLBACK))
    expect(error.status).toBe(400)
    expect(error.message).toBe(
      "http://localhost:41234/callback Couldn't complete authentication: invalid_grant state=[redacted]",
    )
    expect(fake.kill).toHaveBeenCalledOnce()
    expect(onClosed).toHaveBeenCalledWith('/home/me')
  })

  it('returns 404 for an unknown session', async () => {
    const { auth } = setup()
    expect((await rejection(auth.complete('missing', CALLBACK))).status).toBe(404)
  })

  it('reports a claude.ai connector as finished without a callback', async () => {
    const fake = new FakeLogin((f) => {
      f.emit(`Visit this URL to authorize:\r\n  ${link(AUTH_URL)}\r\n\r\nOnce authorized on claude.ai, ...\r\n`)
      f.exit(0)
    })
    const { auth, onClosed } = setup(fake)
    const result = await auth.start('claude.ai Docs', '/home/me')
    expect(result).toMatchObject({ authorization_url: AUTH_URL, callback_expected: false })
    expect(onClosed).toHaveBeenCalledWith('/home/me')
    expect(auth.cancel(result.session_id)).toBe(false)
  })

  it('fails start with scrubbed output when the CLI exits before printing a URL', async () => {
    const fake = new FakeLogin((f) => {
      f.emit('"x" doesn\'t support OAuth login\r\n')
      f.exit(1)
    })
    const { auth } = setup(fake)
    const error = await rejection(auth.start('x', '/home/me'))
    expect(error.status).toBe(502)
    expect(error.message).toBe('"x" doesn\'t support OAuth login')
    expect(fake.kill).toHaveBeenCalledOnce()
  })

  it('kills the process when no URL arrives in time', async () => {
    const fake = new FakeLogin(() => undefined)
    const { auth } = setup(fake, { idleMs: 1000, callMs: 5 })
    const error = await rejection(auth.start('x', '/home/me'))
    expect(error.message).toContain('Timed out')
    expect(fake.kill).toHaveBeenCalledOnce()
  })

  it('kills an idle session after the timeout', async () => {
    vi.useFakeTimers()
    const { auth, fake, onClosed } = setup()
    const { session_id } = await auth.start('posthog', '/home/me')
    vi.advanceTimersByTime(FAST.idleMs - 1)
    expect(fake.kill).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(fake.kill).toHaveBeenCalledOnce()
    expect(onClosed).toHaveBeenCalledWith('/home/me')
    expect((await rejection(auth.complete(session_id, CALLBACK))).status).toBe(404)
  })

  it('cancels a session and replaces an older one for the same server', async () => {
    const fakes = [new FakeLogin(), new FakeLogin(), new FakeLogin()]
    let n = 0
    const spawn = vi.fn(() => {
      const fake = fakes[n] ?? new FakeLogin()
      n += 1
      return fake
    })
    const auth = createMcpAuth(spawn, vi.fn(), FAST)
    const first = await auth.start('posthog', '/home/me')
    const second = await auth.start('posthog', '/home/me')
    expect(fakes[0]?.kill).toHaveBeenCalledOnce()
    expect(auth.cancel(first.session_id)).toBe(false)
    await auth.start('other', '/home/me')
    expect(fakes[1]?.kill).not.toHaveBeenCalled()
    expect(auth.cancel(second.session_id)).toBe(true)
    expect(fakes[1]?.kill).toHaveBeenCalledOnce()
  })
})
