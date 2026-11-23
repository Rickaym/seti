import { describe, expect, it } from 'vitest'
import { CWD, contextOf, HOME, WORKSPACE } from './policy-fixtures.js'
import { readOnly } from './read-only.js'

const ctx = contextOf({ classifier: false })
const reads = (command: string) => readOnly(command, ctx)

describe("Seti's own read-only list", () => {
  it.each([
    'ls',
    'ls -la src',
    'ls *.ts',
    'head src/*.py',
    'cat package.json',
    `cat ${CWD}/README.md ${WORKSPACE}/notes.md`,
    'head -n 20 src/a.ts',
    'tail -n +5 log.txt',
    'wc -l src/a.ts src/b.ts',
    'stat src',
    'du -sh .',
    'diff a.txt b.txt',
    'echo done',
    'pwd',
    'which node',
    'which -a node',
    'grep -rn TODO src',
    "grep -rn 'a/b' --include='*.ts' .",
    "find . -name '*.ts' -type f",
    'find src -newer package.json',
    'git status',
    'git log --oneline -5',
    'git diff HEAD~1 -- src',
    'git show HEAD:package.json',
    'git ls-files',
    'git rev-parse HEAD',
    'git blame src/a.ts',
    'cd src && ls',
    'cd packages/api && cat package.json',
    `cd ${CWD} && git status`,
    'ls src | wc -l',
    'git log --oneline | head -3',
  ])('reads only: %s', (command) => {
    expect(reads(command)).toBe(true)
  })

  it.each([
    ['an unquoted glob with find, which could expand to -delete', 'find . -name *.ts'],
    ['an unquoted glob with git', 'git diff *.ts'],
    ['a find action', 'find . -name x -delete'],
    ['a find exec', 'find . -exec rm {} ;'],
    ['a find print to a file', 'find . -fprint out.txt'],
    ['an output redirect', 'ls > out.txt'],
    ['an input redirect', 'cat < /etc/passwd'],
    ['a redirect to /dev/null, which Claude Code lets run', 'cd app; grep -r pattern . 2>/dev/null'],
    ['which reading aliases', 'which -i node'],
    ['which reading functions', 'which --read-functions node'],
    ['a write to PATH', 'PATH=/tmp ls'],
    ['a variable', 'cat $HOME/.bashrc'],
    ['a substitution', 'ls $(pwd)'],
    ['backticks', 'ls `pwd`'],
    ['a subshell', '(cd /etc && ls)'],
    ['a line it cannot parse', 'ls &&'],
    ['a heredoc', 'cat <<EOF\nx\nEOF'],
    ['a line over 10,000 characters', `echo ${'x'.repeat(10_001)}`],
    ['cd into another directory before git', 'cd src && git status'],
    ['cd out of the working directories', 'cd /etc && ls'],
    ['cd with no target, which goes home', 'cd'],
    ['a path outside the working directories', 'cat /etc/passwd'],
    ['a path under home', 'cat ~/.ssh/id_rsa'],
    ['a path that climbs out', 'ls ../..'],
    ['a glob that climbs out', 'ls ../*'],
    ['a path after a cd that climbs out', 'cd src && cat ../../x'],
    ['an option value outside', 'du --files0-from=/etc/list'],
    ['grep in a file outside', 'grep root /etc/passwd'],
    ['a find root outside', `find ${HOME} -name x`],
    ['a wrapper', 'timeout 5 ls'],
    ['a safe assignment', 'LANG=C ls'],
    ['a shell script', "sh -c 'ls'"],
    ['an exec wrapper', 'xargs cat'],
    ['git with options before the subcommand', 'git -C /tmp status'],
    ['git config before the subcommand', 'git -c core.pager=x log'],
    ['git writing a file', 'git diff --output=patch.txt'],
    ['git with an external diff', 'git diff --ext-diff'],
    ['git outside the repository', 'git diff --no-index /etc/a /etc/b'],
    ['a git write', 'git push'],
    ['a git branch, which can create one', 'git branch new'],
    ['a command off the list', 'sort -o out.txt in.txt'],
    ['a pipe to a command off the list', 'ls | sh'],
    ['a command after a read', 'ls && rm -f a'],
  ])('does not read only: %s', (_label, command) => {
    expect(reads(command)).toBe(false)
  })
})
