import {
  guessLanguage,
  HIGHLIGHT_LIMIT,
  HIGHLIGHT_LINE_MAX,
  highlightable,
  isJson,
  longestLine,
  jsonText,
  languageOf,
  languageOfClasses,
  languageOfPath,
} from '@seti/shared'
import { describe, expect, it } from 'vitest'

describe('fence tags', () => {
  it('maps common tags and aliases to a language', () => {
    expect(languageOf('ts')).toBe('typescript')
    expect(languageOf('TypeScript')).toBe('typescript')
    expect(languageOf('tsx')).toBe('tsx')
    expect(languageOf('js')).toBe('javascript')
    expect(languageOf('py')).toBe('python')
    expect(languageOf('sh')).toBe('bash')
    expect(languageOf('zsh')).toBe('bash')
    expect(languageOf('console')).toBe('bash')
    expect(languageOf('yml')).toBe('yaml')
    expect(languageOf('postgresql')).toBe('sql')
    expect(languageOf('golang')).toBe('go')
    expect(languageOf('rs')).toBe('rust')
    expect(languageOf('patch')).toBe('diff')
    expect(languageOf('css')).toBe('css')
    expect(languageOf('html')).toBe('html')
    expect(languageOf('jsonc')).toBe('json')
  })

  it('leaves unknown, plain and missing tags alone', () => {
    expect(languageOf('mermaid')).toBeNull()
    expect(languageOf('text')).toBeNull()
    expect(languageOf('')).toBeNull()
    expect(languageOf(undefined)).toBeNull()
    expect(languageOf('constructor')).toBeNull()
  })

  it('reads the language from a code element class list', () => {
    expect(languageOfClasses(['language-python'])).toBe('python')
    expect(languageOfClasses(['hljs', 'language-yaml'])).toBe('yaml')
    expect(languageOfClasses(['language-text'])).toBeNull()
    expect(languageOfClasses(undefined)).toBeNull()
    expect(languageOfClasses('language-ts')).toBeNull()
  })
})

describe('file names', () => {
  it('maps extensions to a language', () => {
    expect(languageOfPath('src/app.ts')).toBe('typescript')
    expect(languageOfPath('ui/App.TSX')).toBe('tsx')
    expect(languageOfPath('tools/run.py')).toBe('python')
    expect(languageOfPath('package.json')).toBe('json')
    expect(languageOfPath('deploy/values.yml')).toBe('yaml')
    expect(languageOfPath('Cargo.toml')).toBe('toml')
    expect(languageOfPath('setup.cfg')).toBe('ini')
    expect(languageOfPath('README.md')).toBe('markdown')
    expect(languageOfPath('pom.xml')).toBe('xml')
    expect(languageOfPath('fix.patch')).toBe('diff')
  })

  it('knows files named for their language', () => {
    expect(languageOfPath('Dockerfile')).toBe('dockerfile')
    expect(languageOfPath('deploy/Dockerfile.prod')).toBe('dockerfile')
    expect(languageOfPath('api.dockerfile')).toBe('dockerfile')
    expect(languageOfPath('Makefile')).toBe('makefile')
    expect(languageOfPath('rules.mk')).toBe('makefile')
    expect(languageOfPath('.env')).toBe('ini')
    expect(languageOfPath('app/.env.local')).toBe('ini')
    expect(languageOfPath('.bashrc')).toBe('bash')
  })

  it('leaves prose and unknown files plain', () => {
    expect(languageOfPath('notes.txt')).toBeNull()
    expect(languageOfPath('LICENSE')).toBeNull()
    expect(languageOfPath('build.log')).toBeNull()
  })
})

describe('guessing an untagged block', () => {
  it('finds JSON objects and arrays', () => {
    expect(guessLanguage('{"a": 1}')).toBe('json')
    expect(guessLanguage('  [1, 2, 3]\n')).toBe('json')
  })

  it('finds a unified diff', () => {
    const diff = 'diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -1,2 +1,2 @@\n-old\n+new\n'
    expect(guessLanguage(diff)).toBe('diff')
  })

  it('finds a shell session or script', () => {
    expect(guessLanguage('$ pnpm check\nok')).toBe('bash')
    expect(guessLanguage('#!/usr/bin/env bash\nset -e')).toBe('bash')
    expect(guessLanguage('#!/bin/sh\necho hi')).toBe('bash')
  })

  it('leaves prose and near misses plain', () => {
    expect(guessLanguage('Just some words.')).toBeNull()
    expect(guessLanguage('{ not: json }')).toBeNull()
    expect(guessLanguage('--- a list item\n- another')).toBeNull()
    expect(guessLanguage('$5 is the price')).toBeNull()
  })
})

describe('JSON in tool blocks', () => {
  it('indents one-line JSON two spaces a level', () => {
    expect(jsonText('{"state":"OPEN","checks":[1,2],"empty":{},"none":[]}')).toBe(
      [
        '{',
        '  "state": "OPEN",',
        '  "checks": [',
        '    1,',
        '    2',
        '  ],',
        '  "empty": {},',
        '  "none": []',
        '}',
      ].join('\n'),
    )
  })

  it('keeps strings with brackets, commas and escapes as written', () => {
    expect(jsonText('{"a":"x, {y}: [z]","b":"say \\"hi\\""}')).toBe(
      '{\n  "a": "x, {y}: [z]",\n  "b": "say \\"hi\\""\n}',
    )
  })

  it('keeps big numbers exactly, which parsing would round', () => {
    expect(jsonText('{"id":12345678901234567890}')).toBe('{\n  "id": 12345678901234567890\n}')
  })

  it('leaves JSON that is already on several lines as it is', () => {
    const pretty = '{\n    "a": 1\n}'
    expect(jsonText(`${pretty}\n`)).toBe(pretty)
  })

  it('returns null for text that is not JSON, and for JSON too long to colour', () => {
    expect(jsonText('pod-a Running')).toBeNull()
    expect(jsonText('{"a": 1} trailing')).toBeNull()
    expect(jsonText('"just a string"')).toBeNull()
    const huge = JSON.stringify({ data: 'x'.repeat(HIGHLIGHT_LIMIT) })
    expect(isJson(huge)).toBe(false)
    expect(jsonText(huge)).toBeNull()
  })
})

describe('longestLine', () => {
  it('measures the longest line without its newline', () => {
    expect(longestLine('')).toBe(0)
    expect(longestLine('abc')).toBe(3)
    expect(longestLine('abc\n')).toBe(3)
    expect(longestLine('a\nbcde\nfg')).toBe(4)
    expect(longestLine('a\n\nxyz')).toBe(3)
  })
})

describe('highlightable', () => {
  it('leaves code over the size limit or with a line past the line cap plain', () => {
    expect(highlightable('const a = 1\n'.repeat(1_000))).toBe(true)
    expect(highlightable('a'.repeat(HIGHLIGHT_LINE_MAX))).toBe(true)
    expect(highlightable(`a\n${'b'.repeat(HIGHLIGHT_LINE_MAX + 1)}\nc`)).toBe(false)
    expect(highlightable('x\n'.repeat(HIGHLIGHT_LIMIT))).toBe(false)
  })
})
