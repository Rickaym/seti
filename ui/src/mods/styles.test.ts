import { modManifest } from '@seti/shared'
import { describe, expect, it } from 'vitest'
import { stylesOf } from './styles'

const manifest = (styles: { id: string; file: string }[]) =>
  modManifest.parse({
    id: 'looks',
    name: 'Looks',
    version: '1.0.0',
    seti: '^1.5',
    description: 'Adds a stylesheet',
    contributes: { styles },
  })

describe('mod stylesheets', () => {
  it('loads each declared stylesheet by its scoped name', async () => {
    const css = (text: string) => async () => Promise.resolve(text)
    const shipped = { 'looks.a': css('a {}'), 'looks.b': css('b {}'), 'other.a': css('x {}') }
    const styles = await stylesOf(
      manifest([
        { id: 'a', file: 'a.css' },
        { id: 'b', file: 'b.css' },
      ]),
      shipped,
    )
    expect(styles).toEqual([
      { id: 'looks.a', css: 'a {}' },
      { id: 'looks.b', css: 'b {}' },
    ])
  })

  it('refuses a stylesheet Seti does not ship, so a mod never brings its own CSS', async () => {
    await expect(stylesOf(manifest([{ id: 'a', file: 'a.css' }]), {})).rejects.toThrow(
      'Seti ships no stylesheet looks.a',
    )
  })
})
