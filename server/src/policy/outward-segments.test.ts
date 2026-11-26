import { describe, expect, it } from 'vitest'
import { outwardCalls, type Outward } from './outward.js'

const api = (repo: string): Outward[] => [{ action: 'api', where: { repo } }]
const read = (command: string) => outwardCalls(command, '/work/agent', '/home/me')

const REPLY = [
  `R=own-org/tool; c=$(gh api graphql -f query='query{repository(owner:"own-org",name:"tool"){id}}' --jq '"\\(.a) \\(.b)"'); echo "$c"; t=\${c%% *}; id=\${c##* }`,
  'gh api -X POST repos/$R/pulls/3758/comments/$id/replies -f body="Declined, see the thread." --jq .id',
  'gh api graphql -f query="mutation{resolveReviewThread(input:{threadId:\\"$t\\"}){thread{isResolved}}}" --jq .data',
  'echo "$(date -u +%FT%TZ) tool#3758 resolved" >> /tmp/ops.log',
].join('\n')

describe('a repository path with values Seti cannot read after the repository', () => {
  it.each<[string, Outward[]]>([
    [REPLY, api('own-org/tool')],
    ['gh api -X POST repos/own-org/tool/pulls/1/comments/$id/replies -f body=x', api('own-org/tool')],
    ['gh api -X POST repos/other/tool/pulls/1/comments/$(cat id)/replies -f body=x', api('other/tool')],
    ['gh api -X PATCH repos/own-org/tool/pulls/12 -f body=x', api('own-org/tool')],
    ['gh api -X POST "repos/other/tool/issues/$n/comments" -f body=x', api('other/tool')],
  ])('reads the repository of %s', (command, expected) => {
    expect(read(command)).toEqual(expected)
  })

  it.each([
    'gh api -X POST repos/$O/tool/pulls/1/comments -f body=x',
    'gh api -X POST repos/own-org/$T/pulls/1/comments -f body=x',
    'R=own-org/tool; gh api -X POST repos/${R}$X/pulls/1 -f body=x',
    'gh api -X POST repos/own-org/$(echo tool)/pulls/1 -f body=x',
    'gh api -X POST repos/`cat owner`/tool/pulls/1 -f body=x',
    'gh api -X POST repos/$(printf other)/tool/pulls/1 -f body=x',
    'gh api -X POST "$ENDPOINT" -f body=x',
  ])('cannot tell the repository of %s', (command) => {
    expect(read(command)[0]?.where).toHaveProperty('unknown')
  })

  it.each([
    'gh api graphql -f query=\'mutation{resolveReviewThread(input:{threadId:"x"}){thread{id}}}\'',
    'gh api graphql -f query=\'mutation{addComment(input:{subjectId:"x",body:"y"}){clientMutationId}}\'',
  ])('leaves out what PERM-15 does not read: %s', (command) => {
    expect(read(command)).toEqual([])
  })
})
