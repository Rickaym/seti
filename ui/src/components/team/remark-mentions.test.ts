import { normalizeAgentColor } from '@seti/shared'
import type { Paragraph, Root } from 'mdast'
import { describe, expect, it } from 'vitest'
import { remarkMentions } from './remark-mentions'

const violet = normalizeAgentColor('violet')

const tree = (text: string): Root => ({
  type: 'root',
  children: [{ type: 'paragraph', children: [{ type: 'text', value: text }] }],
})

const properties = (root: Root) =>
  (root.children[0] as Paragraph).children.flatMap((node) =>
    node.data?.hProperties === undefined ? [] : [node.data.hProperties],
  )

describe('remarkMentions', () => {
  it("marks an agent's handle with its colour and leaves other handles plain", () => {
    const root = tree('@builder and @plain, ask @user')
    const mentions = [
      { handle: 'builder', task_id: 't1' },
      { handle: 'plain', task_id: 't2' },
      { handle: 'user', task_id: null },
    ]
    remarkMentions(mentions, (id) => (id === 't1' ? violet : null))()(root)
    const [builder, plain, user] = properties(root)
    expect(builder).toMatchObject({ dataMention: 'builder', dataAgentColor: violet, href: '#agents/t1' })
    expect(plain).toMatchObject({ dataMention: 'plain', dataAgentColor: undefined })
    expect(user).not.toHaveProperty('dataAgentColor')
  })
})
