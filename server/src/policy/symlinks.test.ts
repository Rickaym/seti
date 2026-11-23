import { describe, expect, it } from 'vitest'
import { decide } from './evaluate.js'
import { namedPaths } from './named-paths.js'
import { claudeCall, contextOf, CWD, HOME, type Setup } from './policy-fixtures.js'

/** A call whose paths lead where `links` says, as the node found them on disk. */
function through(tool: string, input: Record<string, unknown>, links: Record<string, string | null>, setup: Setup) {
  const call = { ...claudeCall(tool, input), resolved: new Map(Object.entries(links)) }
  return decide(call, contextOf(setup))
}

const manual = { sandboxed: false, mode: 'ask' } as const
const KEY = `${CWD}/project/key`

describe('a path that leads elsewhere through a symlink', () => {
  it("is denied when its target matches a deny rule, as in Claude Code's example", () => {
    const setup = {
      ...manual,
      rules: [
        ['allow', 'Read(./project/**)'],
        ['deny', 'Read(~/.ssh/**)'],
      ],
    } as const
    const links = { [KEY]: `${HOME}/.ssh/id_rsa` }
    expect(through('Read', { file_path: KEY }, links, setup)).toMatchObject({ verdict: 'deny', rule: 'rule:2' })
    expect(through('Read', { file_path: KEY }, {}, setup).verdict).toBe('allow')
  })

  it('asks when its target matches an ask rule', () => {
    const setup = { ...manual, rules: [['ask', 'Read(//etc/**)']] } as const
    const links = { [`${CWD}/hosts`]: '/etc/hosts' }
    expect(through('Read', { file_path: `${CWD}/hosts` }, links, setup)).toMatchObject({
      verdict: 'ask',
      step: 'ask-rule',
    })
  })

  it('is allowed by a rule only when both the path and its target are covered', () => {
    const setup = { ...manual, rules: [['allow', 'Edit(./src/**)']] } as const
    const file = `${CWD}/src/out.ts`
    expect(through('Edit', { file_path: file }, { [file]: '/srv/out.ts' }, setup).verdict).toBe('ask')
    expect(through('Edit', { file_path: file }, { [file]: `${CWD}/src/real.ts` }, setup).verdict).toBe('allow')
  })

  it('is never allowed by a rule when it leads nowhere Seti can name, and still denied as given', () => {
    const setup = {
      ...manual,
      rules: [
        ['allow', 'Edit(./src/**)'],
        ['deny', 'Edit(./src/locked.ts)'],
      ],
    } as const
    const file = `${CWD}/src/loop.ts`
    expect(through('Edit', { file_path: file }, { [file]: null }, setup).verdict).toBe('ask')
    const locked = `${CWD}/src/locked.ts`
    expect(through('Edit', { file_path: locked }, { [locked]: null }, setup).verdict).toBe('deny')
  })

  it('reads inside the working directories only when its target is inside them too', () => {
    const file = `${CWD}/notes.ipynb`
    const read = (links: Record<string, string>) => through('NotebookRead', { notebook_path: file }, links, manual)
    expect(read({ [file]: '/srv/notes.ipynb' }).verdict).toBe('ask')
    expect(read({}).verdict).toBe('allow')
  })

  it('asks in auto mode for an edit a symlink leads out of the working directories', () => {
    const file = `${CWD}/src/a.ts`
    const auto = { sandboxed: false } as const
    expect(through('Edit', { file_path: file }, { [file]: '/srv/a.ts' }, auto)).toMatchObject({
      verdict: 'ask',
      step: 'mode',
    })
    expect(through('Edit', { file_path: file }, {}, auto).verdict).toBe('allow')
    expect(through('Edit', { file_path: '/srv/a.ts' }, {}, auto).verdict).toBe('defer')
  })

  it('asks where a protected write would go to the classifier, when only its target is protected', () => {
    const file = `${CWD}/config`
    const links = { [file]: `${CWD}/.git/config` }
    expect(through('Edit', { file_path: file }, links, { sandboxed: false })).toMatchObject({
      verdict: 'ask',
      step: 'safety',
    })
    expect(through('Edit', { file_path: file }, links, { sandboxed: false, mode: 'bypass' }).verdict).toBe('allow')
    expect(through('Edit', { file_path: `${CWD}/.git/config` }, {}, { sandboxed: false }).verdict).toBe('defer')
  })

  it('checks the files a shell line reads and writes where they lead', () => {
    const link = `${CWD}/key`
    const denied = { ...manual, rules: [['deny', 'Read(~/.ssh/**)']] } as const
    expect(through('Bash', { command: 'cat key' }, { [link]: `${HOME}/.ssh/id_rsa` }, denied).verdict).toBe('deny')
    const make = { ...manual, rules: [['allow', 'Bash(make:*)']] } as const
    const out = `${CWD}/out.txt`
    expect(through('Bash', { command: 'make > out.txt' }, { [out]: '/srv/out.txt' }, make).verdict).toBe('ask')
    expect(through('Bash', { command: 'make > out.txt' }, {}, make).verdict).toBe('allow')
  })

  it("keeps a read through a link out of Seti's read-only list", () => {
    const noClassifier = { ...manual, classifier: false } as const
    const link = `${CWD}/passwd`
    expect(through('Bash', { command: 'cat passwd' }, { [link]: '/etc/passwd' }, noClassifier).verdict).toBe('ask')
    expect(through('Bash', { command: 'cat passwd' }, {}, noClassifier).verdict).toBe('allow')
  })
})

describe('the paths a call names for its caller to resolve', () => {
  const ctx = { cwd: CWD, home: HOME }

  it('lists the files a file tool reads or writes, absolute', () => {
    expect(namedPaths(claudeCall('Edit', { file_path: 'src/a.ts' }), ctx)).toEqual([`${CWD}/src/a.ts`])
    expect(namedPaths(claudeCall('Read', { file_path: '~/notes.md' }), ctx)).toEqual([`${HOME}/notes.md`])
  })

  it('lists the words of a shell line that may be files, never a glob or a variable', () => {
    const named = namedPaths(claudeCall('Bash', { command: 'cat a.txt $HOME/b *.md --file=/etc/x > out' }), ctx)
    expect(named).toEqual([`${CWD}/a.txt`, '/etc/x', `${CWD}/out`])
  })

  it('names at most 64 paths', () => {
    const files = Array.from({ length: 100 }, (_, i) => `f${String(i)}`)
    const command = ['cat', ...files].join(' ')
    expect(namedPaths(claudeCall('Bash', { command }), ctx)).toHaveLength(64)
  })
})
