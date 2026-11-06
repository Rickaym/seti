import { mentionSpans, type AgentColor, type TeamMention } from '@seti/shared'
import type { Nodes, PhrasingContent, Root, Text } from 'mdast'
import { agentColorAttr } from '@/lib/agent-color-sheet'

const MENTION = ['rounded-sm', 'px-0.5', 'font-medium']

export type ColorOf = (taskId: string) => AgentColor | null

function mentionNode(shown: string, mention: TeamMention, colorOf: ColorOf): Text {
  if (mention.task_id !== null) {
    return {
      type: 'text',
      value: shown,
      data: {
        hName: 'a',
        hProperties: {
          href: `#agents/${mention.task_id}`,
          dataMention: mention.handle,
          dataAgentColor: agentColorAttr(colorOf(mention.task_id))['data-agent-color'],
          className: [...MENTION, 'agent-mark', 'bg-actor-agent/15', 'text-foreground', 'hover:underline'],
        },
      },
    }
  }
  const tone = mention.handle === 'user' ? ['bg-warning/30', 'text-foreground'] : ['bg-primary/10', 'text-primary']
  return {
    type: 'text',
    value: shown,
    data: { hName: 'span', hProperties: { dataMention: mention.handle, className: [...MENTION, ...tone] } },
  }
}

function splitText(node: Text, known: ReadonlyMap<string, TeamMention>, colorOf: ColorOf): PhrasingContent[] {
  const parts: PhrasingContent[] = []
  let at = 0
  for (const span of mentionSpans(node.value)) {
    const mention = known.get(span.handle)
    if (mention === undefined) {
      continue
    }
    if (span.start > at) {
      parts.push({ type: 'text', value: node.value.slice(at, span.start) })
    }
    parts.push(mentionNode(node.value.slice(span.start, span.end), mention, colorOf))
    at = span.end
  }
  if (parts.length === 0) {
    return [node]
  }
  if (at < node.value.length) {
    parts.push({ type: 'text', value: node.value.slice(at) })
  }
  return parts
}

function visit(node: Nodes, known: ReadonlyMap<string, TeamMention>, colorOf: ColorOf): void {
  if (!('children' in node) || node.type === 'link' || node.type === 'linkReference') {
    return
  }
  const children: Nodes[] = []
  for (const child of node.children) {
    if (child.type === 'text') {
      children.push(...splitText(child, known, colorOf))
    } else {
      visit(child, known, colorOf)
      children.push(child)
    }
  }
  Object.assign(node, { children })
}

/** Marks each @handle a message resolved, linking task handles to their task; code stays as is. */
export const remarkMentions = (mentions: readonly TeamMention[], colorOf: ColorOf) => () => (tree: Root) => {
  visit(tree, new Map(mentions.map((mention) => [mention.handle, mention])), colorOf)
}
