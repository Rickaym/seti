import { describe, expect, it } from 'vitest'
import { outwardCalls, type Outward } from './outward.js'

const DIR = '/work/agent'
const HOME = '/home/me'
const REPO = `${HOME}/work/some-repo`

const push = (dir: string, remote: string | null = null): Outward[] => [{ action: 'push', where: { remote, dir } }]
const api = (repo: string): Outward[] => [{ action: 'api', where: { repo } }]
const read = (command: string) => outwardCalls(command, DIR, HOME)

const MARKDOWN = [
  'Linear: [ABC-1 Phone fields](https://example.com/issue/ABC-1)',
  '',
  "Nine fields now use the shared `PhoneInput` (country selector); it's the same value as before.",
  '',
  '| File:line | Field | Verdict |',
  '| --- | --- | --- |',
  '| `app/(root)/(default)/page.tsx:437,448` | Owner phone | Converted; the rest stays |',
  '| `components/sms/card.tsx:129` | SMS test send "To" | Don\'t change |',
  '',
  'Run `git push --force` or `gh api -X POST repos/other/tool/pulls` and edit .git/config: never.',
].join('\n')

describe('heredoc bodies as data', () => {
  it.each<[string, Outward[]]>([
    [
      `cd ~/work/some-repo && cat > /tmp/x/pr.md <<'EOF'\n${MARKDOWN}\nEOF\n~/ops/body-check.sh 2>&1 | head -3; git push -u origin HEAD 2>&1 | tail -2`,
      push(REPO, 'origin'),
    ],
    [`cd ~/work/some-repo && cat > /tmp/pr.md <<"EOF"\n${MARKDOWN}\nEOF\ngit push`, push(REPO)],
    [`cd ~/work/some-repo && cat > /tmp/pr.md <<\\EOF\n${MARKDOWN}\nEOF\ngit push`, push(REPO)],
    [`cd ~/work/some-repo\ncat <<-'END' > /tmp/pr.md\n${MARKDOWN}\n\t\tEND\ngit push`, push(REPO)],
    [`cat > a <<'A' && cat > b <<'B'\nit's\nA\n\`x\nB\ngit push`, push(DIR)],
    [`git commit -q -m "$(cat <<'EOF'\nfix: it's (done)\n\nEOF\n)" && git push`, push(DIR)],
    [
      `cd ~/work/some-repo && git push 2>&1 | tail -1; for n in 1 2; do gh api graphql -f query='q' --jq '.a+((.b//0)|tostring)'; done`,
      push(REPO),
    ],
    [
      "R=owner/repo; for p in 1 2; do gh api -X POST repos/$R/pulls/$p/comments/$c/replies -f body='x'; done",
      api('owner/repo'),
    ],
    ['R=owner/repo; set -- a 7; gh api -X POST repos/$R/pulls/2118/comments/$2/replies -f body=x', api('owner/repo')],
  ])('reads %s', (command, expected) => {
    expect(read(command)).toEqual(expected)
  })

  it.each<[string, Outward[]]>([
    ["bash <<'EOF'\ngit -C /elsewhere push\nEOF", push('/elsewhere')],
    ["cat <<'EOF' | sh\ngit -C /elsewhere push\nEOF", push('/elsewhere')],
    ["env FOO=1 bash -s <<'EOF'\ngit -C /elsewhere push\nEOF", push('/elsewhere')],
    ['cat > /tmp/x <<EOF\n$(git -C /elsewhere push)\nEOF', push('/elsewhere')],
    ['cat > /tmp/x <<EOF\n`git -C /elsewhere push`\nEOF', push('/elsewhere')],
    ['cat > /tmp/x <<EOF\ngit -C /elsewhere push', push('/elsewhere')],
    ['echo $((1<<2))\ngit -C /elsewhere push', push('/elsewhere')],
    ["bash <<'EOF'\ncd ~/work/mine\nEOF\ngit push", push(DIR)],
  ])('still reads what runs: %s', (command, expected) => {
    expect(read(command)).toEqual(expected)
  })

  it.each([
    'cat > /tmp/x <<\'EOF\'\nok\nEOF\necho "$((R=2))"; R=owner/repo; gh api repos/$R/pulls -f x=1',
    'R=owner/repo; gh api repos/$R$X/pulls -f x=1',
    'gh api repos/*/tool/pulls -f x=1',
    "cat > /tmp/x <<'EOF'\nok\nEOF\ngit remote set-url origin https://github.com/other/tool; git push",
  ])('cannot tell the destination of %s', (command) => {
    expect(read(command).some((call) => 'unknown' in call.where)).toBe(true)
  })
})
