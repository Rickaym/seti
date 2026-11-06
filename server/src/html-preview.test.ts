import { describe, expect, it } from 'vitest'
import { previewBody } from './html-preview.js'

const SHIM_START = '<script>(function'

const injected = (page: string) => previewBody(Buffer.from(page, 'utf8'), true).toString('utf8')

/** The page split where the shim went in, with the shim itself taken out. */
function around(page: string): [string, string] {
  const out = injected(page)
  const start = out.indexOf(SHIM_START)
  const end = out.indexOf('</script>', start) + '</script>'.length
  return [out.slice(0, start), out.slice(end)]
}

describe('previewBody', () => {
  it('leaves the page untouched with scripts off', () => {
    const page = Buffer.from('<!doctype html><script>1</script>')
    expect(previewBody(page, false)).toBe(page)
  })

  it('puts the shim right after the doctype, keeping it first', () => {
    expect(around('<!doctype html>\n<html><head><script>a()</script>')).toEqual([
      '<!doctype html>',
      '\n<html><head><script>a()</script>',
    ])
  })

  it('matches an uppercase or legacy doctype after comments and an XML prolog', () => {
    const page = '<?xml version="1.0"?>\n<!-- built -->\n<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01//EN">'
    expect(around(`${page}<HTML><HEAD><SCRIPT>a()</SCRIPT>`)).toEqual([page, '<HTML><HEAD><SCRIPT>a()</SCRIPT>'])
  })

  it('puts the shim first in a page with no doctype or head', () => {
    expect(around('<p>hi</p><script>a()</script>')).toEqual(['', '<p>hi</p><script>a()</script>'])
  })

  it('keeps a byte-order mark first and every other byte as it was', () => {
    const page = '\uFEFF<!doctype html><p>caf\u00e9 \u2713</p>'
    expect(around(page)).toEqual(['\uFEFF<!doctype html>', '<p>caf\u00e9 \u2713</p>'])
    const latin = Buffer.from([0x3c, 0x70, 0x3e, 0xe9, 0xff])
    expect(previewBody(latin, true).subarray(-5)).toEqual(latin)
  })
})
