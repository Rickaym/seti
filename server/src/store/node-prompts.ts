import { now, sql } from '../db.js'
import type { Db } from '../pg.js'

/** How long the prompt of a node ask is kept, as long as the control plane keeps its answers. */
const KEEP_MS = 24 * 60 * 60 * 1000

/** The prompt row a node ask opened and the text that went out with it. */
export interface NodePrompt {
  promptId: number
  text: string
}

export const nodePrompts = {
  /** The prompt the ask already opened, if a control plane before this one answered it. */
  find: async (askId: string): Promise<NodePrompt | undefined> =>
    (await sql<NodePrompt[]>`SELECT prompt_id AS "promptId", text FROM node_prompt WHERE ask_id = ${askId}`).at(0),
  /** Records the prompt the ask opened, in the transaction that stores its row. */
  keep: async (db: Db, askId: string, taskId: string, prompt: NodePrompt): Promise<void> => {
    const at = now()
    await db`DELETE FROM node_prompt WHERE at < ${new Date(Date.now() - KEEP_MS).toISOString()}`
    await db`INSERT INTO node_prompt (ask_id, task_id, prompt_id, text, at)
      VALUES (${askId}, ${taskId}, ${prompt.promptId}, ${prompt.text}, ${at})`
  },
}
