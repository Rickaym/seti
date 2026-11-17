import type { SharedTool, SharedToolCode, SharedToolNeed } from '@seti/shared'
import { now, sql } from '../db.js'

type ToolRecord = Omit<SharedToolCode, 'needs' | 'bytes'> & { needs: string }

const toCode = ({ needs, ...row }: ToolRecord): SharedToolCode => ({
  ...row,
  needs: JSON.parse(needs) as SharedToolNeed[],
  bytes: Buffer.byteLength(row.content),
})

/** The tool as lists show it, without its code. */
export const withoutCode = ({ content: _content, ...tool }: SharedToolCode): SharedTool => tool

const toTool = (row: ToolRecord): SharedTool => withoutCode(toCode(row))

type PublishedTool = Pick<
  SharedToolCode,
  'name' | 'description' | 'file' | 'content' | 'sha256' | 'needs' | 'proposer_task_id' | 'proposer_title'
>

export const sharedTools = {
  list: async (): Promise<SharedTool[]> =>
    (await sql<ToolRecord[]>`SELECT * FROM shared_tool ORDER BY name`).map(toTool),
  /** Every tool with its code, for writing the plugin folders. */
  listCode: async (): Promise<SharedToolCode[]> =>
    (await sql<ToolRecord[]>`SELECT * FROM shared_tool ORDER BY name`).map(toCode),
  get: async (name: string): Promise<SharedToolCode | undefined> =>
    (await sql<ToolRecord[]>`SELECT * FROM shared_tool WHERE name = ${name}`).map(toCode).at(0),
  /** Stores the tool, replacing a published one of the same name; the new version is on. */
  publish: async (tool: PublishedTool): Promise<void> => {
    await sql`INSERT INTO shared_tool
      (name, description, file, content, sha256, needs, proposer_task_id, proposer_title, created_at, updated_at)
      VALUES (${tool.name}, ${tool.description}, ${tool.file}, ${tool.content}, ${tool.sha256},
        ${JSON.stringify(tool.needs)}, ${tool.proposer_task_id}, ${tool.proposer_title}, ${now()}, ${now()})
      ON CONFLICT (name) DO UPDATE SET description = excluded.description, file = excluded.file,
        content = excluded.content, sha256 = excluded.sha256, needs = excluded.needs,
        proposer_task_id = excluded.proposer_task_id, proposer_title = excluded.proposer_title,
        enabled = true, updated_at = excluded.updated_at`
  },
  setEnabled: async (name: string, enabled: boolean): Promise<boolean> =>
    (await sql`UPDATE shared_tool SET enabled = ${enabled}, updated_at = ${now()} WHERE name = ${name}`).count > 0,
  remove: async (name: string): Promise<boolean> => (await sql`DELETE FROM shared_tool WHERE name = ${name}`).count > 0,
}
