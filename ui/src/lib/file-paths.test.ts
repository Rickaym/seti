import { filesLinkHash, filesLinkOfHash, fileUrlTarget } from '@seti/shared'
import type { Root } from 'mdast'
import { describe, expect, it } from 'vitest'
import {
  fileHref,
  fileRefOfUrl,
  fileRefsInText,
  pathInCode,
  pathOfHref,
  pathsInText,
  remarkFilePaths,
  textPieces,
} from './file-paths'

const paths = (text: string) => pathsInText(text).map((match) => match.path)

describe('paths in prose', () => {
  it('finds relative, absolute and home paths', () => {
    expect(
      paths('The updated files are out/sample-welcome.pdf (Developer) and out/sample-fde-welcome.pdf (FDE).'),
    ).toEqual(['out/sample-welcome.pdf', 'out/sample-fde-welcome.pdf'])
    expect(paths('Wrote /home/me/work/report.md and ~/notes/today.md')).toEqual([
      '/home/me/work/report.md',
      '~/notes/today.md',
    ])
  })

  it('finds paths through folders whose names start with a dot', () => {
    expect(paths('Saved /home/user/.seti/workspace/52/Audit-Event-Types.csv for you')).toEqual([
      '/home/user/.seti/workspace/52/Audit-Event-Types.csv',
    ])
    expect(paths('see .github/workflows/ci.yml and ~/.claude/settings.json')).toEqual([
      '.github/workflows/ci.yml',
      '~/.claude/settings.json',
    ])
    expect(paths('not ../up/one.md')).toEqual([])
  })

  it('finds bare names with a known extension and drops line numbers', () => {
    expect(paths('See notes.md, then README.md:12 and src/app.ts:40:2.')).toEqual([
      'notes.md',
      'README.md',
      'src/app.ts',
    ])
  })

  it('leaves ordinary words, versions, numbers and URLs alone', () => {
    expect(paths('Version 1.2.3 is fine, e.g. at 3/4 speed')).toEqual([])
    expect(paths('Open https://example.com/docs/guide.md for more')).toEqual([])
    expect(paths('a notes.md.bak file')).toEqual([])
    expect(paths('a .env file')).toEqual([])
  })

  it('reports where each path sits, with its line suffix', () => {
    const [match] = pathsInText('open src/a.ts:3 now')
    expect(match).toEqual({ start: 5, end: 15, path: 'src/a.ts' })
  })
})

describe('paths in inline code', () => {
  it('takes a whole span that is a path', () => {
    expect(pathInCode('out/sample-welcome.pdf')).toBe('out/sample-welcome.pdf')
    expect(pathInCode('package.json')).toBe('package.json')
    expect(pathInCode('server/src/app.ts:12')).toBe('server/src/app.ts')
    expect(pathInCode('/home/me/.seti/workspace/a.csv')).toBe('/home/me/.seti/workspace/a.csv')
  })

  it('ignores commands, words and identifiers', () => {
    expect(pathInCode('pnpm check')).toBeNull()
    expect(pathInCode('useState')).toBeNull()
    expect(pathInCode('1.5')).toBeNull()
    expect(pathInCode('https://example.com/a.md')).toBeNull()
  })
})

describe('URLs that name a file', () => {
  it('takes Files download links on any host, or with no host', () => {
    const raw = '/api/tasks/9f1c/files/raw?root=workspace&path=reports%2Fq3.md'
    for (const url of [
      `https://seti.example.com${raw}`,
      `http://127.0.0.1:3006${raw}&download=1&v=2026-10-27T10%3A00%3A00.000Z`,
      `https://seti.tail1234.ts.net:8443${raw}`,
      raw,
    ]) {
      expect(fileRefOfUrl(url)).toBe(url)
    }
    expect(fileUrlTarget(`https://any.host${raw}`)).toEqual({
      task_id: '9f1c',
      root: 'workspace',
      path: 'reports/q3.md',
    })
  })

  it('takes Files deep links on any host, the form Copy link gives out', () => {
    const hash = '#agents/9f1c/files/workspace/reports/q%203.md'
    for (const url of [`https://seti.example.com/${hash}`, `http://127.0.0.1:5173/${hash}`, `/${hash}`]) {
      expect(fileRefOfUrl(url)).toBe(url)
      expect(fileUrlTarget(url)).toEqual({ task_id: '9f1c', root: 'workspace', path: 'reports/q 3.md' })
    }
    expect(fileUrlTarget('https://seti.example.com/#agents/9f1c/files/workspace/')).toBeNull()
    expect(fileUrlTarget('https://seti.example.com/#agents/9f1c/files/cwd/../etc/passwd')).toBeNull()
    expect(fileUrlTarget('https://seti.example.com/#agents/9f1c/sub/toolu_1')).toBeNull()
  })

  it('takes file:// URLs as their path', () => {
    expect(fileRefOfUrl('file:///home/me/.seti/workspace/52/a%20b.csv')).toBe('/home/me/.seti/workspace/52/a b.csv')
    expect(fileRefOfUrl('file://localhost/srv/x.md')).toBe('/srv/x.md')
  })

  it('leaves app links, other sites and incomplete Files links alone', () => {
    for (const url of [
      '#agents/9f1c',
      'https://seti.example.com/#agents/9f1c',
      'https://github.com/acme/app/blob/main/docs/guide.md',
      'https://example.com/api/tasks/9f1c/files/raw?root=cwd',
      'https://example.com/api/tasks/9f1c/files/text?root=cwd&path=a.md',
      'https://example.com/other/api/tasks/9f1c/files/raw?root=cwd&path=a.md',
      'mailto:me@example.com',
      'file://server/share/a.md',
    ]) {
      expect(fileRefOfUrl(url), url).toBeNull()
    }
  })

  it('keeps workspace paths for the prose matcher, not the URL one', () => {
    expect(fileRefOfUrl('~/.seti/workspace/52/notes.md')).toBeNull()
    expect(paths('Saved ~/.seti/workspace/52/notes.md')).toEqual(['~/.seti/workspace/52/notes.md'])
  })
})

const LINK = 'https://seti.example.com/api/tasks/t1/files/raw?root=cwd&path=src%2Fa.ts'

describe('Files deep links', () => {
  it('round-trips files and folders through the hash', () => {
    const file = { task_id: 't-1', root: 'cwd', path: 'src/a b#c.ts', type: 'file' as const }
    expect(filesLinkHash(file)).toBe('agents/t-1/files/cwd/src/a%20b%23c.ts')
    expect(filesLinkOfHash(`#${filesLinkHash(file)}`)).toEqual(file)
    const folder = { task_id: 't-1', root: 'cwd', path: 'src/panels', type: 'dir' as const }
    expect(filesLinkHash(folder)).toBe('agents/t-1/files/cwd/src/panels/')
    expect(filesLinkOfHash(filesLinkHash(folder))).toEqual(folder)
    const root = { task_id: 't-1', root: 'cwd', path: '', type: 'dir' as const }
    expect(filesLinkOfHash(`#/${filesLinkHash(root)}`)).toEqual(root)
  })

  it('refuses other hashes, bad escapes and paths that climb out', () => {
    expect(filesLinkOfHash('#agents/t-1')).toBeNull()
    expect(filesLinkOfHash('#agents/t-1/files')).toBeNull()
    expect(filesLinkOfHash('#settings/files/cwd/a.md')).toBeNull()
    expect(filesLinkOfHash('#agents/t-1/files/cwd/%E0%A4%A')).toBeNull()
    expect(filesLinkOfHash('#agents/t-1/files/cwd/a/../../b')).toBeNull()
  })

  it('finds a pasted deep link in a message', () => {
    const url = 'https://seti.example.com/#agents/t1/files/cwd/src/a.ts'
    expect(fileRefsInText(`Look at ${url}.`)).toEqual([{ start: 8, end: 8 + url.length, ref: url }])
  })
})

describe('file references in plain text', () => {
  it('finds Files links, file:// URLs and paths, and trims sentence punctuation', () => {
    const text = `See (${LINK}), file:///srv/x.md and notes/plan.md.`
    expect(fileRefsInText(text).map((found) => found.ref)).toEqual([LINK, '/srv/x.md', 'notes/plan.md'])
    expect(fileRefsInText(`Open /api/tasks/t1/files/raw?root=cwd&path=a.md now`)).toEqual([
      { start: 5, end: 47, ref: '/api/tasks/t1/files/raw?root=cwd&path=a.md' },
    ])
  })

  it('skips other URLs and the paths inside them', () => {
    expect(fileRefsInText('Read https://example.com/docs/guide.md or http://x.test/a/b.md')).toEqual([])
  })

  it('keeps a reference inside a sentence inline', () => {
    expect(textPieces('Look at notes/plan.md please', { first: true, last: true })).toMatchObject([
      { ref: null, text: 'Look at ' },
      { ref: 'notes/plan.md', text: 'notes/plan.md', card: false },
      { ref: null, text: ' please' },
    ])
  })

  it('makes a reference alone on its line a card that takes the line breaks with it', () => {
    const pieces = textPieces(`Here it is:\n${LINK}\nThanks`, { first: true, last: true })
    expect(pieces).toMatchObject([
      { ref: null, text: 'Here it is:' },
      { ref: LINK, text: `\n${LINK}\n`, card: true },
      { ref: null, text: 'Thanks' },
    ])
    expect(pieces.map((piece) => piece.text).join('')).toBe(`Here it is:\n${LINK}\nThanks`)
    expect(textPieces(`  ${LINK}  `, { first: true, last: true })).toMatchObject([
      { ref: LINK, text: `  ${LINK}  `, card: true },
    ])
  })

  it('cards each of several lone lines without sharing a newline', () => {
    const pieces = textPieces('a.md\nb.md', { first: true, last: true })
    expect(pieces).toMatchObject([
      { ref: 'a.md', text: 'a.md\n', card: true },
      { ref: 'b.md', text: 'b.md', card: true },
    ])
  })

  it('leaves a line that shares an edge with an attachment chip inline', () => {
    expect(textPieces('notes/plan.md', { first: false, last: true })[0]).toMatchObject({ card: false })
    expect(textPieces('notes/plan.md', { first: true, last: false })[0]).toMatchObject({ card: false })
    expect(textPieces('x\nnotes/plan.md\n', { first: false, last: false })[1]).toMatchObject({ card: true })
  })
})

describe('the remark plugin', () => {
  it('links paths in text and code but not inside existing links or code blocks', () => {
    const tree: Root = {
      type: 'root',
      children: [
        {
          type: 'paragraph',
          children: [
            { type: 'text', value: 'Saved out/a.pdf and ' },
            { type: 'inlineCode', value: 'notes/today.md' },
            { type: 'link', url: 'https://x.test', children: [{ type: 'text', value: 'docs/b.md' }] },
          ],
        },
        { type: 'code', value: 'cat out/a.pdf' },
      ],
    }
    const linked = remarkFilePaths()(tree)
    expect(linked.children[0]).toEqual({
      type: 'paragraph',
      children: [
        { type: 'text', value: 'Saved ' },
        { type: 'link', url: fileHref('out/a.pdf'), children: [{ type: 'text', value: 'out/a.pdf' }] },
        { type: 'text', value: ' and ' },
        { type: 'link', url: fileHref('notes/today.md'), children: [{ type: 'inlineCode', value: 'notes/today.md' }] },
        { type: 'link', url: 'https://x.test', children: [{ type: 'text', value: 'docs/b.md' }] },
      ],
    })
    expect(linked.children[1]).toEqual({ type: 'code', value: 'cat out/a.pdf' })
  })

  it('turns Files links into file links and leaves other links alone', () => {
    const files = 'https://seti.example.com/api/tasks/t1/files/raw?root=cwd&path=out%2Fa.pdf'
    const paragraph = (url: string) => ({
      type: 'paragraph' as const,
      children: [{ type: 'link' as const, url, children: [{ type: 'text' as const, value: url }] }],
    })
    const tree: Root = {
      type: 'root',
      children: [
        paragraph(files),
        paragraph('https://github.com/acme/app/blob/main/README.md'),
        paragraph('#agents/t1'),
        { type: 'paragraph', children: [{ type: 'inlineCode', value: files }] },
      ],
    }
    const linked = remarkFilePaths()(tree)
    expect(linked.children[0]).toEqual({
      type: 'paragraph',
      children: [{ type: 'link', url: fileHref(files), children: [{ type: 'text', value: files }] }],
    })
    expect(linked.children[1]).toEqual(paragraph('https://github.com/acme/app/blob/main/README.md'))
    expect(linked.children[2]).toEqual(paragraph('#agents/t1'))
    expect(linked.children[3]).toEqual({
      type: 'paragraph',
      children: [{ type: 'link', url: fileHref(files), children: [{ type: 'inlineCode', value: files }] }],
    })
  })

  it('round-trips paths through the href', () => {
    expect(pathOfHref(fileHref('out/a b.pdf'))).toBe('out/a b.pdf')
    expect(pathOfHref('https://example.com')).toBeNull()
  })
})
