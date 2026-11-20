import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { folderUnsavedWork, reposWithin, unsavedWork } from './git-state.js'
import { findCandidates, judgeCandidates, rebuildableKind } from './rebuildable.js'

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'rebuildable-'))

afterAll(() => {
  fs.rmSync(ROOT, { recursive: true, force: true })
})

const byText = (a: string, b: string) => a.localeCompare(b)

const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }

function git(cwd: string, ...args: string[]): string {
  // eslint-disable-next-line sonarjs/no-os-command-from-path -- tests use the git on PATH like the server
  return execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@t.invalid', ...args], {
    cwd,
    env: GIT_ENV,
    stdio: 'pipe',
  })
    .toString()
    .trim()
}

function write(file: string, text = 'x'): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
}

function repo(dir: string, files: Record<string, string>): string {
  fs.mkdirSync(dir, { recursive: true })
  git(dir, 'init', '-q', '--initial-branch=main')
  for (const [name, text] of Object.entries(files)) {
    write(path.join(dir, name), text)
  }
  git(dir, 'add', '-A', '-f')
  git(dir, 'commit', '-q', '-m', 'seed')
  return dir
}

describe('rebuildable folders', () => {
  it('knows dependencies, caches and virtualenvs by name, and build output only as a maybe', () => {
    const base = path.join(ROOT, 'kinds')
    write(path.join(base, '.venv', 'pyvenv.cfg'))
    write(path.join(base, 'venv', 'notes.md'))
    expect(rebuildableKind(path.join(base, 'node_modules'))).toBe('always')
    expect(rebuildableKind(path.join(base, '__pycache__'))).toBe('always')
    expect(rebuildableKind(path.join(base, '.venv'))).toBe('always')
    expect(rebuildableKind(path.join(base, 'venv'))).toBeNull()
    expect(rebuildableKind(path.join(base, 'dist'))).toBe('ignored')
    expect(rebuildableKind(path.join(base, 'target'))).toBe('ignored')
    expect(rebuildableKind(path.join(base, 'src'))).toBeNull()
  })

  it('finds them a few levels down without entering them, .git or symlinks', () => {
    const base = path.join(ROOT, 'find')
    write(path.join(base, 'app', 'node_modules', 'dep', 'node_modules', 'inner', 'i.js'))
    write(path.join(base, 'app', 'src', '__pycache__', 'm.pyc'))
    write(path.join(base, '.git', 'node_modules', 'x'))
    fs.symlinkSync(path.join(base, 'app'), path.join(base, 'alias'))

    const found = findCandidates({ base, root: 'scratch' }).candidates.map((c) => path.relative(base, c.dir))

    expect(found.toSorted(byText)).toEqual(['app/node_modules', 'app/src/__pycache__'])
  })

  it("empties a sandbox's /tmp and leaves its run and ssh folders", () => {
    const base = path.join(ROOT, 'sandbox-task')
    write(path.join(base, 'tmp', 'scratch.log'))
    write(path.join(base, 'run', 'node_modules', 'x'))
    write(path.join(base, 'home', '.cache', 'ms-playwright', 'chromium'))

    const found = findCandidates({ base, root: 'sandbox' }).candidates.map((c) => path.relative(base, c.dir))

    expect(found.toSorted(byText)).toEqual(['home/.cache', 'tmp'])
  })

  it('removes build output only where git ignores it, and nothing git tracks files in', async () => {
    const base = path.join(ROOT, 'judge')
    const app = repo(path.join(base, 'app'), {
      '.gitignore': 'dist/\nnode_modules/\n',
      'src/main.ts': 'x',
      'vendor/node_modules/kept.js': 'tracked',
    })
    write(path.join(app, 'dist', 'out.js'))
    write(path.join(app, 'build', 'out.js'))
    write(path.join(app, 'node_modules', 'dep', 'index.js'))
    write(path.join(base, 'loose', 'dist', 'out.js'))
    write(path.join(base, 'loose', 'node_modules', 'x.js'))
    const { candidates } = findCandidates({ base, root: 'scratch' })

    const judged = await judgeCandidates(base, candidates)

    const rel = (dir: string) => path.relative(base, dir)
    expect(judged.targets.map(rel).toSorted(byText)).toEqual(['app/dist', 'app/node_modules', 'loose/node_modules'])
    expect(Object.fromEntries(judged.kept.map((kept) => [rel(kept.dir), kept.reason]))).toEqual({
      'app/build': 'git does not ignore it, so it may be source',
      'app/vendor/node_modules': 'git tracks files in it',
      'loose/dist': 'it is in no git repository, so it may be source',
    })
  })
})

describe('unsaved work', () => {
  it('finds uncommitted changes and commits on no remote, and passes pushed clean clones', async () => {
    const origin = path.join(ROOT, 'origin.git')
    git(ROOT, 'init', '-q', '--bare', '--initial-branch=main', origin)
    const seed = repo(path.join(ROOT, 'seed'), { 'a.txt': 'a' })
    git(seed, 'remote', 'add', 'origin', origin)
    git(seed, 'push', '-q', '-u', 'origin', 'main')
    const clean = path.join(ROOT, 'holder', 'clean')
    git(ROOT, 'clone', '-q', origin, clean)
    const local = repo(path.join(ROOT, 'holder', 'deep', 'local'), { 'b.txt': 'b' })
    const dirty = path.join(ROOT, 'dirty')
    git(ROOT, 'clone', '-q', origin, dirty)
    write(path.join(dirty, 'a.txt'), 'changed')

    expect(await unsavedWork(clean)).toBeNull()
    expect(await unsavedWork(dirty)).toBe(`${dirty} has uncommitted changes`)
    expect(await unsavedWork(local)).toBe(`${local} has 1 commit(s) that are not pushed`)
    expect(reposWithin(path.join(ROOT, 'holder'))?.toSorted(byText)).toEqual([clean, local])
    expect(await folderUnsavedWork(path.join(ROOT, 'holder'))).toBe(`${local} has 1 commit(s) that are not pushed`)
    expect(await folderUnsavedWork(path.join(ROOT, 'kinds'))).toBeNull()
  })
})
