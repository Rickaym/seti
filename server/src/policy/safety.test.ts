import { describe, expect, it } from 'vitest'
import { criticalRemoval, isProtected } from './safety.js'

describe('protected paths', () => {
  it.each([
    '/w/app/.git/config',
    '/w/app/.git',
    '/w/app/.claude/settings.json',
    '/w/app/.vscode/tasks.json',
    '/home/me/.config/git/config',
    '/home/me/.bashrc',
    '/w/app/.npmrc',
    '/w/app/.mcp.json',
    '/w/app/pkg/.husky/pre-commit',
    '/w/app/lefthook.yml',
  ])('protects %s', (target) => {
    expect(isProtected(target)).toBe(true)
  })

  it.each([
    '/w/app/src/index.ts',
    '/w/app/.claude/worktrees/x/file.ts',
    '/home/me/.claude/plans/plan.md',
    '/w/app/.claude/agent-memory/notes.md',
    '/home/me/.config/other/x',
    '/w/app/.github/workflows/ci.yml',
  ])('leaves %s writable', (target) => {
    expect(isProtected(target)).toBe(false)
  })
})

describe('critical removals', () => {
  const where = { cwd: '/w/app', home: '/home/me', dirs: ['/w/app', '/w/extra'] }
  const critical = (line: string) => criticalRemoval(line.split(' '), where)

  it.each([
    'rm -rf /',
    'rm -rf /usr',
    'rm -rf ~',
    'rm -rf /home/me',
    'rm -rf .',
    'rm -rf ..',
    'rm -rf /w',
    'rmdir /data',
    'rm -rf $DIR/*',
    'rm -rf ${DIR}/',
    'rm -rf $1/*',
    'rm -rf $TMPDIR/mnt',
    'rm -rf $(pwd)',
    'rm -rf ~/$(cmd)',
    'rm -rf \\',
    'rm -rf logs/*/*',
    'rm -rf logs/*/',
    'rm -rf /w/extra/*',
    'rm -f -- /',
  ])('%s is critical', (line) => {
    expect(critical(line)).toBe(true)
  })

  it.each(['rm -rf build', 'rm -rf /w/app/dist', 'rm -rf /w/extra', 'rm file.txt', 'rm $FILE', 'ls /', 'rm -rf tmp/*'])(
    '%s is not',
    (line) => {
      expect(critical(line)).toBe(false)
    },
  )
})
