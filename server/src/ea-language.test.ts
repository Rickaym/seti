import fs from 'node:fs'
import path from 'node:path'
import {
  EA_LANGUAGE_DEFAULT,
  EA_LANGUAGE_MULTI,
  EA_LANGUAGES,
  eaLanguage,
  eaLanguageName,
  eaSettingsInput,
} from '@seti/shared'
import { describe, expect, it } from 'vitest'

const EA_LANGUAGE_SOURCE = path.resolve(import.meta.dirname, '../../ea/src/seti_ea/language.py')
const WAKE = { wake_enabled: false, wake_phrase: 'Hey Seti', keep_awake_seconds: 30 }

/** The code and name pairs of the EA's own copy of the list, in its order. */
function pythonLanguages(): { code?: string; name?: string }[] {
  const source = fs.readFileSync(EA_LANGUAGE_SOURCE, 'utf8')
  const block = /^LANGUAGES: dict\[str, str\] = \{\n([\s\S]*?)\n\}/m.exec(source)?.[1] ?? ''
  return [...block.matchAll(/^ {4}"(?<code>[^"]+)": "(?<name>[^"]+)",$/gm)].map((match) => ({ ...match.groups }))
}

describe('EA languages', () => {
  it('opens with English, the default, and Multilingual', () => {
    expect(EA_LANGUAGE_DEFAULT).toBe('en')
    expect(EA_LANGUAGES.slice(0, 2).map((language) => language.code)).toEqual(['en', EA_LANGUAGE_MULTI])
    expect(eaLanguageName('multi')).toBe('Multilingual')
  })

  it('lists each code once and the rest by name', () => {
    const codes = EA_LANGUAGES.map((language) => language.code)
    expect(new Set(codes).size).toBe(codes.length)
    const names = EA_LANGUAGES.slice(2).map((language) => language.name)
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)))
  })

  it('takes a listed code and nothing else', () => {
    expect(eaLanguage.parse('tr')).toBe('tr')
    for (const bad of ['Turkish', 'TR', 'th', 'en-US', '']) {
      expect(eaLanguage.safeParse(bad).success).toBe(false)
    }
    expect(eaSettingsInput.parse(WAKE).language).toBeUndefined()
    expect(eaSettingsInput.parse({ ...WAKE, language: 'multi' }).language).toBe('multi')
    expect(eaSettingsInput.safeParse({ ...WAKE, language: 'xx' }).success).toBe(false)
  })

  it('names a code and falls back to the code itself', () => {
    expect(eaLanguageName('tr')).toBe('Turkish')
    expect(eaLanguageName('xx')).toBe('xx')
  })

  it("matches the EA's own copy of the list", () => {
    expect(pythonLanguages()).toEqual(EA_LANGUAGES.map(({ code, name }) => ({ code, name })))
  })
})
