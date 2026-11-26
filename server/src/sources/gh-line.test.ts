import { describe, expect, it } from 'vitest'
import { cleanFilter, cleanJq } from './gh-filters.js'
import { ghLine } from './gh-line.js'

/** Each read as `form repo item filter`, and what the line's result holds. */
function summary(command: string) {
  const line = ghLine(command)
  const reads = line.reads.map((read) =>
    read.form === 'api'
      ? `api ${read.repo} ${read.number ?? '-'} ${read.filter}`
      : `${read.form} ${read.repo ?? '-'} ${read.item ?? '-'} ${read.filter}`,
  )
  return { reads, output: line.output }
}

describe('ghLine', () => {
  it.each([
    ['a plain view', 'gh pr view 12 -R acme/api', ['view acme/api 12 none'], 'whole'],
    ['a joined -R', 'gh pr view 12 -Racme/api', ['view acme/api 12 none'], 'whole'],
    ['a folder change first', 'cd /work/api && gh pr view 12 --repo acme/api', ['view acme/api 12 none'], 'whole'],
    ['quoted words', `gh pr view "12" -R 'acme/api' --json "title,body"`, ['view acme/api 12 none'], 'whole'],
    ['a jq field', "gh pr view 12 -R acme/api --json title --jq '.title'", ['view acme/api 12 clean'], 'whole'],
    [
      'a jq with a literal',
      `gh pr view 12 -R acme/api --json title --jq '"x" + .title'`,
      ['view acme/api 12 any'],
      'whole',
    ],
    ['a template', "gh pr view 12 -R acme/api --json title -t '{{.title}}'", ['view acme/api 12 any'], 'whole'],
    ['a pipe to head', 'gh pr view 12 -R acme/api 2>&1 | head -40', ['view acme/api 12 none'], 'cut'],
    ['a pipe to grep', "gh pr diff 12 -R acme/api | grep -nE 'build' | head -n 5", ['diff acme/api 12 none'], 'cut'],
    ['a pipe to sed', "gh pr diff 12 -R acme/api | sed -n '10,40p'", ['diff acme/api 12 none'], 'cut'],
    ['a literal variable', 'R=acme/api; gh pr view 12 -R "$R"', ['view acme/api 12 none'], 'whole'],
    ['an api path', "gh api repos/acme/api/pulls/12 --jq '.body'", ['api acme/api 12 clean'], 'whole'],
    ['an api GET', 'gh api -X GET repos/acme/api/issues/12/comments --paginate', ['api acme/api 12 none'], 'whole'],
    [
      'two reads',
      'gh pr view 12 -R acme/api --json title; gh pr view 13 -R acme/api --json title',
      ['view acme/api 12 none', 'view acme/api 13 none'],
      'mixed',
    ],
    ['an echo beside it', 'echo ===; gh pr view 12 -R acme/api', ['view acme/api 12 none'], 'mixed'],
    ['a pipe to awk', "gh pr view 12 -R acme/api | awk '{print}'", ['view acme/api 12 none'], 'mixed'],
    ['a pipe to sed s', "gh pr view 12 -R acme/api | sed 's/a/b/'", ['view acme/api 12 none'], 'mixed'],
    ['a grep of a file too', 'gh pr view 12 -R acme/api | grep x notes.md', ['view acme/api 12 none'], 'mixed'],
    ['a recursive grep', 'gh pr view 12 -R acme/api | grep -rn x', ['view acme/api 12 none'], 'mixed'],
    [
      'a jq with an argument',
      'gh pr view 12 -R acme/api --json title | jq --arg a b .title',
      ['view acme/api 12 none'],
      'mixed',
    ],
  ])('%s', (_name, command, reads, output) => {
    expect(summary(command)).toEqual({ reads, output })
  })

  it.each([
    ['a loop variable', 'for n in 1 2; do gh pr view $n -R acme/api; done'],
    ['a computed repository', 'gh pr view 12 -R "$(cat repo)"'],
    ['a variable set twice', 'R=acme/api; R=acme/web; gh pr view 12 -R $R'],
    ['GH_REPO set', 'GH_REPO=acme/web gh pr view 12 -R acme/api'],
    ['GH_HOST set', 'export GH_HOST=git.example.com; gh pr view 12 -R acme/api'],
    ['output sent to a file', 'gh pr view 12 -R acme/api > /tmp/pr.txt; cat /tmp/pr.txt'],
    ['an api write by method', 'gh api -X POST repos/acme/api/issues/12/comments -f body=x'],
    ['an api write by field', 'gh api repos/acme/api/issues/12/comments -f body=x'],
    ['an api on another host', 'gh api --hostname git.example.com repos/acme/api/pulls/12'],
    ['a comment', 'gh pr comment 12 -R acme/api --body x'],
    ['a list', 'gh pr list -R acme/api --json number --jq .[].number'],
    ['a repository with a host', 'gh pr view 12 -R git.example.com/acme/api'],
    ['two items', 'gh pr view 12 13 -R acme/api'],
    ['a jq and a template', "gh pr view 12 -R acme/api --json title --jq .title -t '{{.title}}'"],
  ])('leaves out %s', (_name, command) => {
    expect(ghLine(command).reads).toEqual([])
  })
})

describe('filters', () => {
  it.each([
    ['.title', true],
    ['.comments[] | {author: .author.login, body}', true],
    ['.[] | select(.state == "open")', false],
    ['$ENV.TOKEN', false],
    ['env.HOME', false],
    ['[72,105] | implode', false],
    ['.body | @base64d', false],
    ['input', false],
  ])('jq %s is clean: %s', (program, clean) => {
    expect(cleanJq(program)).toBe(clean)
  })

  it.each([
    [['head', '-40'], true],
    [['tail', '-n', '5'], true],
    [['grep', '-i', '-A2', 'build'], true],
    [['grep', '-e', 'a', '-e', 'b'], true],
    [['sort'], true],
    [['cut', '-d', ',', '-f', '1'], true],
    [['jq', '-r', '.title'], true],
    [['grep', 'build', 'notes.md'], false],
    [['grep', '-f', 'patterns', 'x'], false],
    [['grep', '-rn', 'x'], false],
    [['rg', '-r', 'fake', 'x'], false],
    [['sed', 's/a/b/'], false],
    [['sed', '-n', '1,5p'], true],
    [['jq', '-r', '"x"'], false],
    [['jq', '--rawfile', 'a', 'f', '.'], false],
    [['tee', 'out.txt'], false],
    [['xargs', 'echo'], false],
    [['head', '$N'], false],
  ])('%j is clean: %s', (words, clean) => {
    expect(cleanFilter(words)).toBe(clean)
  })
})
