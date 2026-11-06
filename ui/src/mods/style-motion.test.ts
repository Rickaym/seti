import fs from 'node:fs'
import path from 'node:path'
import { modManifest } from '@seti/shared'
import { describe, expect, it } from 'vitest'

const MODS_DIR = path.resolve(import.meta.dirname, '../../../mods')
const MOTION_OK = '@media (prefers-reduced-motion: no-preference)'

interface Rule {
  prelude: string
  body: string
}

/** A stylesheet's top-level rules, each as its prelude and the text between its braces. */
function topLevelRules(css: string): Rule[] {
  const rules: Rule[] = []
  let depth = 0
  let start = 0
  let open = 0
  for (let i = 0; i < css.length; i++) {
    if (css[i] === '{') {
      open = depth === 0 ? i : open
      depth++
    } else if (css[i] === '}') {
      depth--
      if (depth === 0) {
        rules.push({ prelude: css.slice(start, open).trim(), body: css.slice(open + 1, i) })
        start = i + 1
      }
    }
  }
  return rules
}

const stylesheets = fs.readdirSync(MODS_DIR).flatMap((folder) => {
  const manifest = modManifest.parse(JSON.parse(fs.readFileSync(path.join(MODS_DIR, folder, 'seti-mod.json'), 'utf8')))
  return manifest.contributes.styles.map((style): [string, Rule[]] => [
    `${folder}/${style.file}`,
    topLevelRules(fs.readFileSync(path.join(MODS_DIR, folder, style.file), 'utf8')),
  ])
})

describe('motion in bundled mod stylesheets', () => {
  it.each(stylesheets)('%s moves only when the user has not asked for reduced motion', (_file, rules) => {
    for (const rule of rules.filter((r) => r.prelude !== MOTION_OK && !r.prelude.startsWith('@keyframes '))) {
      expect(rule.body).not.toMatch(/\b(?:animation|transition)\b/)
    }
  })

  it.each(stylesheets)('%s animates only what the compositor runs', (_file, rules) => {
    for (const { body } of rules.filter((r) => r.prelude.startsWith('@keyframes '))) {
      const properties = body
        .split('\n')
        .filter((line) => line.includes(':'))
        .map((line) => line.trim().split(':')[0])
      expect(properties.filter((property) => property !== 'transform' && property !== 'opacity')).toEqual([])
    }
  })
})
