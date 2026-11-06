import { describe, expect, it } from 'vitest'
import { parseFeed } from './feed.js'

const RSS = `<?xml version="1.0"?>
<rss version="2.0"><channel><title>Blog</title>
  <item><title>First &amp; best</title><link>https://blog.test/1</link><guid>post-1</guid>
    <description>Hello</description><pubDate>Tue, 29 Sep 2026 10:00:00 GMT</pubDate></item>
  <item><title>No guid</title><link>https://blog.test/2</link></item>
</channel></rss>`

const ATOM = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom"><title>Releases</title>
  <entry><id>tag:x,2026:1</id><title type="html">v1.2.0</title>
    <link rel="self" href="https://x.test/self"/><link rel="alternate" href="https://x.test/v1.2.0"/>
    <summary>Fixes</summary><updated>2026-09-30T08:00:00Z</updated></entry>
</feed>`

const RDF = `<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://purl.org/rss/1.0/"
  xmlns:dc="http://purl.org/dc/elements/1.1/">
  <item><title>Old style</title><link>https://old.test/a</link><dc:date>2026-09-01</dc:date></item>
</rdf:RDF>`

describe('parseFeed', () => {
  it('reads RSS 2.0 items, keyed by guid or link', () => {
    expect(parseFeed(RSS)).toEqual([
      {
        id: 'post-1',
        title: 'First & best',
        link: 'https://blog.test/1',
        summary: 'Hello',
        published: 'Tue, 29 Sep 2026 10:00:00 GMT',
        updated: null,
      },
      {
        id: 'https://blog.test/2',
        title: 'No guid',
        link: 'https://blog.test/2',
        summary: '',
        published: null,
        updated: null,
      },
    ])
  })

  it('reads Atom entries with their alternate link', () => {
    expect(parseFeed(ATOM)).toEqual([
      {
        id: 'tag:x,2026:1',
        title: 'v1.2.0',
        link: 'https://x.test/v1.2.0',
        summary: 'Fixes',
        published: null,
        updated: '2026-09-30T08:00:00Z',
      },
    ])
  })

  it('reads RSS 1.0', () => {
    expect(parseFeed(RDF)).toMatchObject([{ id: 'https://old.test/a', title: 'Old style', published: '2026-09-01' }])
  })

  it('refuses what is not a feed, and entity declarations', () => {
    expect(() => parseFeed('{"items": []}')).toThrow('Not an RSS or Atom feed')
    expect(() => parseFeed('<!DOCTYPE x [<!ENTITY a "aaaa">]><rss/>')).toThrow('declare their own entities')
  })
})
