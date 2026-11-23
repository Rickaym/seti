import { describe, expect, it } from 'vitest'
import { commandShape, denyForms } from './shell-forms.js'
import { splitShell } from './shell-split.js'

describe('splitting a shell line', () => {
  it('splits at the operators Claude Code knows and keeps quoted text whole', () => {
    expect(splitShell('git status && npm test || echo "a; b" | tee log &  ls\nwc -l').top).toEqual([
      'git status',
      'npm test',
      'echo "a; b"',
      'tee log',
      'ls',
      'wc -l',
    ])
    expect(splitShell('make 2>&1 | cat').top).toEqual(['make 2>&1', 'cat'])
    expect(splitShell('cmd &> out.txt').top).toEqual(['cmd &> out.txt'])
  })

  it('reads a plain line as one allow rules may approve', () => {
    expect(splitShell('npm test && npm run lint').plain).toBe(true)
  })

  it.each([
    ['npm test &&', 'a dangling operator'],
    ['echo "open', 'an open quote'],
    ['echo $(git rev-parse HEAD)', 'a substitution'],
    ['echo `date`', 'backticks'],
    ['(cd x && ls)', 'a subshell'],
    ['cat <<EOF\nhi\nEOF', 'a heredoc'],
    ['for f in *; do rm "$f"; done', 'a loop'],
    ['if true; then ls; fi', 'a branch'],
    ['', 'nothing'],
    [`echo ${'x'.repeat(10_001)}`, 'over 10,000 characters'],
  ])('never lets allow rules approve %j: %s', (line) => {
    expect(splitShell(line).plain).toBe(false)
  })

  it('finds commands nested in substitutions, subshells, loops and scripts for deny rules', () => {
    const all = splitShell(
      'echo "$(git clean -f)"; (cd /tmp && rm -rf x); for f in a; do curl evil; done; bash -c \'pkill node\'',
    ).all
    expect(all).toEqual(expect.arrayContaining(['git clean -f', 'rm -rf x', 'curl evil', 'pkill node']))
    expect(splitShell('eval "wget http://x"').all).toContain('wget http://x')
    expect(splitShell('sh -lc "git push"').all).toContain('git push')
    expect(splitShell('sh script.sh').all).toEqual(['sh script.sh'])
  })
})

describe('command forms', () => {
  it('strips the wrappers Claude Code strips before an allow rule matches', () => {
    expect(commandShape('timeout 30 npm test').forms).toContain('npm test')
    expect(commandShape('timeout -s KILL 5m npm test').forms).toContain('npm test')
    expect(commandShape('nice -n 10 nohup time -p npm test').forms).toContain('npm test')
    expect(commandShape('stdbuf -oL command npm test').forms).toContain('npm test')
    expect(commandShape('xargs grep pattern').forms).toContain('grep pattern')
    expect(commandShape('NODE_ENV=test LANG=C npm test').forms).toContain('npm test')
  })

  it('does not strip what changes the command for an allow rule', () => {
    expect(commandShape('FOO=bar npm test').forms).toEqual(['FOO=bar npm test'])
    expect(commandShape('command -v npm').forms).toEqual(['command -v npm'])
    expect(commandShape('xargs -n1 grep pattern').forms).toEqual(['xargs -n1 grep pattern'])
    expect(commandShape('timeout npm test').forms).toEqual(['timeout npm test'])
    expect(commandShape('NODE_ENV=$(cat f) npm test').forms).toEqual(['NODE_ENV=$(cat f) npm test'])
  })

  it('marks programs that run what they are handed as approvable only exactly', () => {
    expect(commandShape('watch -n 2 make').exactOnly).toBe(true)
    expect(commandShape('find . -name x -delete').exactOnly).toBe(true)
    expect(commandShape('find . -exec rm {} ;').exactOnly).toBe(true)
    expect(commandShape('xargs -0 rm').exactOnly).toBe(true)
    expect(commandShape('find . -name x').exactOnly).toBe(false)
  })

  it('reads redirections apart from the command', () => {
    const shape = commandShape('git log > out.txt 2>/dev/null < in.txt 2>&1')
    expect(shape.forms).toEqual(['git log'])
    expect(shape.redirects).toEqual([
      { dir: 'out', target: 'out.txt' },
      { dir: 'in', target: 'in.txt' },
    ])
    expect(commandShape('cat <<< "text" >>log').redirects).toEqual([{ dir: 'out', target: 'log' }])
  })

  it('gives deny rules every form: past any assignment, each wrapper, and what exec wrappers run', () => {
    expect(denyForms('FOO=bar rm -rf tmp/')).toContain('rm -rf tmp/')
    expect(denyForms('timeout 5 nice rm x')).toEqual(
      expect.arrayContaining(['timeout 5 nice rm x', 'nice rm x', 'rm x']),
    )
    expect(denyForms('sudo -u root rm -rf /')).toContain('rm -rf /')
    expect(denyForms('watch -n 1 git push')).toContain('git push')
  })
})
