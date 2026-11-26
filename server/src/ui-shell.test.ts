import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createUiShell, shellFallback } from './ui-shell.js'

const page = (build: string) => `<!doctype html><meta name="seti-build" content="${build}"><title>Seti</title>`

let dist = ''

const write = (file: string, body: string) => {
  fs.mkdirSync(path.dirname(path.join(dist, file)), { recursive: true })
  fs.writeFileSync(path.join(dist, file), body)
}

function serve() {
  const shell = createUiShell(dist)
  const app = new Hono()
  app.get('/*', shellFallback(shell))
  return { shell, get: async (pathname: string) => app.request(pathname) }
}

beforeEach(() => {
  dist = fs.mkdtempSync(path.join(os.tmpdir(), 'seti-ui-shell-'))
})

afterEach(() => {
  fs.rmSync(dist, { recursive: true, force: true })
})

describe('the UI shell', () => {
  it('names the build index.html carries, and follows a new one', () => {
    write('index.html', page('aaaa1111'))
    const { shell } = serve()
    expect(shell.build()).toBe('aaaa1111')
    fs.rmSync(path.join(dist, 'index.html'))
    write('index.html', page('bbbb2222'))
    expect(shell.build()).toBe('bbbb2222')
  })

  it('has no build without index.html or without the build tag', () => {
    const { shell } = serve()
    expect(shell.build()).toBeNull()
    write('index.html', '<!doctype html><title>Seti</title>')
    expect(shell.build()).toBeNull()
  })

  it('answers the worker and the shell from the last complete build while the files are away', async () => {
    write('index.html', page('aaaa1111'))
    write('sw.js', 'self.version = "a"')
    const { get } = serve()
    expect(await (await get('/agents')).text()).toContain('aaaa1111')
    expect(await (await get('/sw.js')).text()).toContain('"a"')

    fs.rmSync(path.join(dist, 'index.html'))
    fs.rmSync(path.join(dist, 'sw.js'))
    const shell = await get('/index.html')
    expect(shell.status).toBe(200)
    expect(await shell.text()).toContain('aaaa1111')
    const worker = await get('/sw.js')
    expect(worker.status).toBe(200)
    expect(worker.headers.get('content-type')).toMatch(/^text\/javascript/)
    expect(await worker.text()).toContain('"a"')
  })

  it('says the UI is not built only when no build was ever there', async () => {
    const { get } = serve()
    expect((await get('/')).status).toBe(503)
    expect((await get('/sw.js')).status).toBe(503)
  })

  it('answers a missing file with 404, never with the shell', async () => {
    write('index.html', page('aaaa1111'))
    const { get } = serve()
    for (const pathname of ['/assets/index-gone1234.js', '/assets/style-gone1234.css', '/icon-9.png']) {
      const res = await get(pathname)
      expect(res.status, pathname).toBe(404)
      expect(res.headers.get('content-type'), pathname).not.toMatch(/html/)
      expect(res.headers.get('cache-control'), pathname).toBe('no-store')
    }
    expect((await get('/agents')).status).toBe(200)
  })
})
