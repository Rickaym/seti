import type { PromptAttachment } from '@seti/shared'
import type { InputPriority } from './runtimes/adapter.js'

/** A message waiting for its session to start, or for the turn being cut short to end. */
export interface NextMessage {
  prompt: string | null
  /** Files sent with the prompt; images among them go to the agent with the text. */
  attachments?: PromptAttachment[]
  /** It cut the running turn short, so it goes out once that turn ended. */
  interrupted: boolean
  /** The user's last message sent again; refused while a turn runs. */
  retry?: boolean
  /** The browser's id for the send, which its prompt row carries. */
  client_id?: string
  /** Who wrote it when not the user, such as the EA starting an agent; the agent is told. */
  from?: string
  /**
   * For updates with no user text: reach a running turn at its next step, or now for a person's
   * message, which moves the turn's running commands to the background; not after the turn.
   */
  priority?: Exclude<InputPriority, 'later'>
  /** For updates with no user text: also take the ones held for the user's next message. */
  held?: boolean
}
