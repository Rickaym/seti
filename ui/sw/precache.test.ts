import { describe, expect, it } from 'vitest'
import { passesThrough, planPrecache, type Precache } from './precache'

const PRECACHE: Precache = {
  version: 'next',
  urls: [
    '/assets/index-NEW00001.js',
    '/assets/index-SAME0001.css',
    '/assets/viewer-LAZY0001.js',
    '/assets/viewer-LAZY0002.js',
    '/icon-192.png',
    '/index.html',
    '/manifest.webmanifest',
  ],
  lazy: ['/assets/viewer-LAZY0001.js', '/assets/viewer-LAZY0002.js'],
}

const held = (entries: [string, string][]) => new Map(entries)

describe('planPrecache', () => {
  it('fetches everything on a first install', () => {
    expect(planPrecache(PRECACHE, held([]), false)).toEqual({ copy: [], fetch: PRECACHE.urls })
  })

  it('copies hashed files an old cache holds and fetches the rest', () => {
    const old = held([
      ['/assets/index-SAME0001.css', 'seti-shell-old'],
      ['/assets/viewer-LAZY0001.js', 'seti-shell-old'],
      ['/assets/index-OLD00001.js', 'seti-shell-old'],
    ])
    expect(planPrecache(PRECACHE, old, false)).toEqual({
      copy: [
        ['/assets/index-SAME0001.css', 'seti-shell-old'],
        ['/assets/viewer-LAZY0001.js', 'seti-shell-old'],
      ],
      fetch: [
        '/assets/index-NEW00001.js',
        '/assets/viewer-LAZY0002.js',
        '/icon-192.png',
        '/index.html',
        '/manifest.webmanifest',
      ],
    })
  })

  it('always fetches unhashed files, even when a cache holds them', () => {
    const old = held([
      ['/index.html', 'seti-shell-old'],
      ['/manifest.webmanifest', 'seti-shell-old'],
      ['/icon-192.png', 'seti-shell-old'],
    ])
    const plan = planPrecache(PRECACHE, old, false)
    expect(plan.copy).toEqual([])
    expect(plan.fetch).toEqual(expect.arrayContaining(['/index.html', '/manifest.webmanifest', '/icon-192.png']))
  })

  it('copies from whichever cache holds each file', () => {
    const old = held([
      ['/assets/index-SAME0001.css', 'seti-shell-a'],
      ['/assets/viewer-LAZY0001.js', 'seti-shell-b'],
    ])
    expect(planPrecache(PRECACHE, old, false).copy).toEqual([
      ['/assets/index-SAME0001.css', 'seti-shell-a'],
      ['/assets/viewer-LAZY0001.js', 'seti-shell-b'],
    ])
  })

  it('leaves lazy chunks to first use when saving data', () => {
    expect(planPrecache(PRECACHE, held([]), true)).toEqual({
      copy: [],
      fetch: [
        '/assets/index-NEW00001.js',
        '/assets/index-SAME0001.css',
        '/icon-192.png',
        '/index.html',
        '/manifest.webmanifest',
      ],
    })
  })

  it('still copies lazy chunks an old cache holds when saving data, since copies are free', () => {
    const old = held([['/assets/viewer-LAZY0002.js', 'seti-shell-old']])
    const plan = planPrecache(PRECACHE, old, true)
    expect(plan.copy).toEqual([['/assets/viewer-LAZY0002.js', 'seti-shell-old']])
    expect(plan.fetch).not.toContain('/assets/viewer-LAZY0001.js')
  })
})

describe('passesThrough', () => {
  it('leaves the API, Access and share pages to the network, and nothing else', () => {
    for (const pathname of ['/api', '/api/tasks', '/cdn-cgi/access/login', '/share', '/share/abc', '/share/abc/raw']) {
      expect(passesThrough(pathname), pathname).toBe(true)
    }
    for (const pathname of ['/', '/index.html', '/shared', '/apis', '/assets/share-1.js', '/#share']) {
      expect(passesThrough(pathname), pathname).toBe(false)
    }
  })
})
