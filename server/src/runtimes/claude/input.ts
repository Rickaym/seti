import type { UUID } from 'node:crypto'
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import type { InputContent, SessionInput } from '../adapter.js'

/** The images of an input as the image blocks that follow its text. */
const imageBlocks = (images: InputContent['images']) =>
  images.map((image) => ({
    type: 'image' as const,
    source: { type: 'base64' as const, media_type: image.mime, data: image.data },
  }))

/** An input as the user message Claude Code reads: its text alone, or the text and its images. */
const userMessage = ({ id, content, priority }: SessionInput): SDKUserMessage => ({
  type: 'user',
  message: {
    role: 'user',
    content:
      content.images.length === 0
        ? content.text
        : [{ type: 'text', text: content.text }, ...imageBlocks(content.images)],
  },
  parent_tool_use_id: null,
  uuid: id as UUID,
  ...(priority === undefined ? {} : { priority }),
  // Claude Code joins only a person's "now" message to the running turn; others end it.
  ...(priority === 'now' ? { origin: { kind: 'human' } } : {}),
})

/** A session's inputs as Claude Code's streaming prompt. */
export async function* claudePrompt(input: AsyncIterable<SessionInput>): AsyncGenerator<SDKUserMessage> {
  for await (const next of input) {
    yield userMessage(next)
  }
}
