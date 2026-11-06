import { globCouldContain, hostsWithin } from '@seti/shared'
import { describe, expect, it } from 'vitest'
import { grantedFrom, setiHostProblem } from './scopes.js'

describe('mod scopes', () => {
  it('lists only folders a glob could reach, never dot folders through **', () => {
    expect(globCouldContain('notes/**/*.md', '')).toBe(true)
    expect(globCouldContain('notes/**/*.md', 'notes')).toBe(true)
    expect(globCouldContain('notes/**/*.md', 'notes/a/b')).toBe(true)
    expect(globCouldContain('notes/**/*.md', 'notes/.git')).toBe(false)
    expect(globCouldContain('notes/**/*.md', 'src')).toBe(false)
    expect(globCouldContain('docs/*.md', 'docs')).toBe(true)
    expect(globCouldContain('docs/*.md', 'docs/deeper')).toBe(false)
    expect(globCouldContain('*.md', 'any')).toBe(false)
  })

  it('sends a connection only where the grant and the connection both reach', () => {
    expect(hostsWithin(['api.example.com', 'other.example.com'], ['api.example.com'])).toEqual(['api.example.com'])
    expect(hostsWithin(['*.example.com'], ['api.example.com'])).toEqual(['api.example.com'])
    expect(hostsWithin(['*.a.example.com'], ['*.example.com'])).toEqual(['*.a.example.com'])
    expect(hostsWithin(['*.example.com'], ['*.example.org'])).toEqual([])
  })

  it("refuses Seti's own names", () => {
    for (const host of ['localhost', 'seti.localhost', 'app-pr-1.seti.localhost', 'x.localhost']) {
      expect(setiHostProblem(host), host).toBe(`${host} is Seti itself, which mods never reach`)
    }
    expect(setiHostProblem('api.example.com')).toBeNull()
  })

  it('binds the connection the user picked to the connection grant alone', () => {
    const { grants, scopes } = grantedFrom([
      { capability: { name: 'storage' }, connection_id: 'ignored' },
      { capability: { name: 'connection', variable: 'KEY', hosts: ['api.example.com'] }, connection_id: 'c1' },
    ])
    expect(grants).toEqual(['storage', 'connection'])
    expect(scopes.connection?.connectionId).toBe('c1')
    expect(scopes.storage).toEqual({ name: 'storage' })
  })
})
