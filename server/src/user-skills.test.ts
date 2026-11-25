import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { userSkills } from './user-skills.js'

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'seti-skills-')))
afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

function skill(dir: string, text: string): void {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'SKILL.md'), text)
}

describe("the user's skills", () => {
  const skills = path.join(root, 'skills')
  skill(path.join(skills, 'pdf'), '---\nname: pdf\ndescription: "Read and write PDF files"\n---\nBody\n')
  skill(path.join(skills, 'b-named'), '---\ndescription: Named by its folder\n---\n')
  skill(path.join(skills, 'no-description'), '---\nname: quiet\n---\n')
  skill(path.join(root, 'elsewhere', 'outside'), '---\nname: outside\ndescription: Lives elsewhere\n---\n')
  fs.symlinkSync(path.join(root, 'elsewhere', 'outside'), path.join(skills, 'linked'))
  skill(path.join(skills, 'long'), `---\nname: long\ndescription: ${'x'.repeat(900)}\n---\n`)
  skill(path.join(skills, 'odd'), '---\nname: odd\ndescription: tab\there and \u0007 bell\n---\n')

  it('lists each folder whose SKILL.md has a description, by folder name', () => {
    const listed = userSkills(skills)
    expect(listed.map((each) => each.folder)).toEqual(['b-named', 'long', 'odd', 'pdf'])
    expect(listed.find((each) => each.folder === 'pdf')).toEqual({
      name: 'pdf',
      description: 'Read and write PDF files',
      folder: 'pdf',
    })
    expect(listed.find((each) => each.folder === 'b-named')?.name).toBe('b-named')
  })

  it('leaves out a skill that links outside the folder, and keeps each description short and plain', () => {
    const listed = userSkills(skills)
    expect(listed.some((each) => each.name === 'outside')).toBe(false)
    expect(listed.find((each) => each.folder === 'long')?.description).toHaveLength(400)
    expect(listed.find((each) => each.folder === 'odd')?.description).toBe('tab here and bell')
  })

  it('lists none when the folder is missing', () => {
    expect(userSkills(path.join(root, 'none'))).toEqual([])
  })
})
