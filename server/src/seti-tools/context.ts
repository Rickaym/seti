import {
  contextPackInput,
  REVISION_REASON_MAX,
  writeContextFileInput,
  type ContextFile,
  type ContextPack,
  type RevisionObjectRef,
} from '@seti/shared'
import { z } from 'zod'
import {
  createPack,
  deletePack,
  requirePack,
  saveContextFile,
  setPackLinkedByDefault,
  updatePack,
} from '../context-changes.js'
import { listContextFiles, readContextFile } from '../context-files.js'
import { revertRevision } from '../revert.js'
import { byAgent } from '../revisions.js'
import { packForDisplay } from '../seti-guide.js'
import { pickOne } from './refs.js'
import { done, setiTool, ToolRefusal, type ToolContext } from './tool.js'
import { contextPacks } from '../store/context.js'
import { revisions } from '../store/revisions.js'

const HISTORY_LIMIT = 30
const MATCH_LIMIT = 20
const OPENING_CHARS = 1200

const packRef = z.string().trim().min(1).describe("The pack's id or name.")
const fileRef = z
  .string()
  .trim()
  .min(1)
  .describe('user for the user-level CLAUDE.md, else the file key or the repo and file name from list_context_files.')
const reason = z
  .string()
  .trim()
  .min(1)
  .max(REVISION_REASON_MAX)
  .optional()
  .describe("Why you change it, as the user will read it in the change history; quote the user's words if given.")

/** An agent's change, attributed to it with its reason so the user sees and can revert it. */
const source = (ctx: ToolContext, why: string | undefined, fallback: string) => byAgent(ctx.caller.id, why ?? fallback)

async function findPack(ref: string): Promise<ContextPack> {
  return pickOne((await contextPacks.list()).map(packForDisplay), ref, 'context pack', (p) => [p.id, p.name])
}

const fileName = (file: ContextFile) => (file.key === 'user' ? 'user-level CLAUDE.md' : `${file.group} ${file.label}`)

async function findFile(ref: string): Promise<ContextFile> {
  const files = await listContextFiles()
  const user = files.find((file) => file.key === 'user')
  if (user !== undefined && /^(user|user-level|global|~\/\.claude\/CLAUDE\.md)$/i.test(ref.trim())) {
    return user
  }
  return pickOne(files, ref, 'context file', (file) => [file.key, fileName(file)])
}

/** Text added at the end of a file or pack, a blank line after what it holds. */
const appended = (text: string, more: string) => (text.trim() === '' ? `${more}\n` : `${text.trimEnd()}\n\n${more}\n`)

/** A long text as its size, headings and opening, or only the lines that mention the query. */
function summarise(text: string, query: string | undefined) {
  const lines = text.split('\n')
  if (query !== undefined) {
    const low = query.toLowerCase()
    return { matches: lines.filter((line) => line.toLowerCase().includes(low)).slice(0, MATCH_LIMIT) }
  }
  return {
    headings: lines.filter((line) => line.startsWith('#')),
    opening: text.slice(0, OPENING_CHARS),
    ...(text.length > OPENING_CHARS ? { cut: `${String(text.length - OPENING_CHARS)} more characters` } : {}),
  }
}

const listContextPacks = setiTool({
  name: 'list_context_packs',
  description:
    'List context packs, the reusable instructions agents include: kind, whether new agents get them by default and size.',
  input: {},
  run: async () =>
    (await contextPacks.list()).map((pack) => ({
      id: pack.id,
      name: pack.name,
      description: pack.description,
      kind: pack.kind,
      builtin: pack.builtin,
      linked_by_default: pack.linked_by_default,
      words: pack.body.split(/\s+/).filter((word) => word !== '').length,
    })),
})

const getContextPack = setiTool({
  name: 'get_context_pack',
  description:
    'One context pack: its description, size, headings and opening, or the lines matching a query. Pass full for the whole text.',
  input: {
    pack: packRef,
    query: z.string().trim().min(1).optional(),
    full: z.boolean().default(false),
  },
  run: async ({ pack: ref, query, full }) => {
    const pack = await findPack(ref)
    const { body, ...fields } = pack
    return { ...fields, chars: body.length, ...(full ? { body } : summarise(body, query)) }
  },
})

const createContextPack = setiTool({
  name: 'create_context_pack',
  description: 'Create a context pack: reusable instructions agents can include.',
  input: {
    name: contextPackInput.shape.name,
    description: contextPackInput.shape.description,
    body: contextPackInput.shape.body,
    reason,
  },
  run: async ({ reason: why, ...fields }, ctx) => {
    const { value } = await createPack(fields, 'reference', source(ctx, why, 'Created with seti tools'))
    return { id: value.id, name: value.name }
  },
})

const updateContextPack = setiTool({
  name: 'update_context_pack',
  description:
    'Change a context pack: rename it, change its description, replace its body or add text at its end, or whether new agents get it by default. Agents that include it read the change. The built-in Seti guide takes only the default.',
  input: {
    pack: packRef,
    name: contextPackInput.shape.name.optional(),
    description: z.string().trim().max(500).optional(),
    body: contextPackInput.shape.body.optional(),
    append: z.string().min(1).optional(),
    linked_by_default: z.boolean().optional(),
    reason,
  },
  run: async ({ pack: ref, name, description, body, append, linked_by_default: byDefault, reason: why }, ctx) => {
    const pack = await requirePack((await findPack(ref)).id)
    const edits = [name, description, body, append].some((value) => value !== undefined)
    if (!edits && byDefault === undefined) {
      throw new ToolRefusal('Give a field to change.')
    }
    if (edits) {
      const text = body ?? pack.body
      const fields = {
        name: name ?? pack.name,
        description: description ?? pack.description,
        body: append === undefined ? text : appended(text, append),
      }
      await updatePack(pack.id, fields, source(ctx, why, 'Updated with seti tools'))
    }
    if (byDefault !== undefined) {
      await setPackLinkedByDefault(pack.id, byDefault)
    }
    const after = await requirePack(pack.id)
    return { id: after.id, name: after.name, linked_by_default: after.linked_by_default, chars: after.body.length }
  },
})

const deleteContextPack = setiTool({
  name: 'delete_context_pack',
  description: 'Permanently delete a context pack; the built-in Seti guide cannot be deleted.',
  input: { pack: packRef },
  run: async ({ pack: ref }) => {
    const pack = await findPack(ref)
    await deletePack(pack.id)
    return done(`Deleted the context pack ${pack.name}.`)
  },
})

const listContextFilesTool = setiTool({
  name: 'list_context_files',
  description:
    "List the CLAUDE.md files Seti manages: the user-level one and each repo's, with size and when each changed.",
  input: {},
  run: async () =>
    (await listContextFiles()).map((file) => ({
      key: file.key,
      name: fileName(file),
      path: file.path,
      exists: file.exists,
      size: file.size,
      modified_at: file.modified_at,
    })),
})

const readContextFileTool = setiTool({
  name: 'read_context_file',
  description:
    'Read one CLAUDE.md file Seti manages: its size, headings and opening, the lines matching a query, or with full its whole text.',
  input: { file: fileRef, query: z.string().trim().min(1).optional(), full: z.boolean().default(false) },
  run: async ({ file: ref, query, full }) => {
    const file = await readContextFile((await findFile(ref)).key)
    const fields = { key: file.key, path: file.path, size: file.size, modified_at: file.modified_at }
    if (!file.exists) {
      return { ...fields, note: 'Not created yet.' }
    }
    return { ...fields, ...(full ? { content: file.content } : summarise(file.content, query)) }
  },
})

const writeContextFileTool = setiTool({
  name: 'write_context_file',
  description:
    'Write a CLAUDE.md file Seti manages: replace its text with content, or add append to its end. Agents read it from their next session.',
  input: {
    file: fileRef,
    content: writeContextFileInput.shape.content.optional(),
    append: z.string().min(1).optional(),
    reason,
  },
  run: async ({ file: ref, content, append, reason: why }, ctx) => {
    if (content === undefined && append === undefined) {
      throw new ToolRefusal('Give the new content, or text to append.')
    }
    const current = await readContextFile((await findFile(ref)).key)
    const base = content ?? current.content
    const text = append === undefined ? base : appended(base, append)
    if (text.trimEnd() === current.content.trimEnd()) {
      throw new ToolRefusal(`${current.path} already says that.`)
    }
    const saved = await saveContextFile(current.key, text, current.hash, source(ctx, why, 'Written with seti tools'))
    return { key: saved.value.key, path: saved.value.path, size: saved.value.size, revision: saved.revision }
  },
})

/** The pack or file the arguments name, as a revision reference; null when none is named. */
async function objectOf(args: {
  pack?: string | undefined
  file?: string | undefined
}): Promise<RevisionObjectRef | null> {
  if (args.pack !== undefined && args.file !== undefined) {
    throw new ToolRefusal('Name one pack or file.')
  }
  if (args.pack !== undefined) {
    return { object_type: 'context_pack', object_id: (await findPack(args.pack)).id }
  }
  return args.file === undefined ? null : { object_type: 'context_file', object_id: (await findFile(args.file)).key }
}

const objectArgs = {
  pack: z.string().trim().min(1).optional().describe("A context pack's name or id."),
  file: z.string().trim().min(1).optional().describe('A CLAUDE.md file, as for read_context_file.'),
}

const listChanges = setiTool({
  name: 'list_changes',
  description:
    'Changes agents made to context packs and CLAUDE.md files that the user has not looked at yet; or, naming one pack or file, its change history, newest first.',
  input: objectArgs,
  run: async (args) => {
    const ref = await objectOf(args)
    return ref === null ? revisions.unseen() : revisions.list(ref, HISTORY_LIMIT)
  },
})

const revertChange = setiTool({
  name: 'revert_change',
  description:
    'Set a context pack or CLAUDE.md file back to how it was before one change (its latest update unless you give change), saved as a new change.',
  input: { ...objectArgs, change: z.number().int().positive().optional().describe('The change id from list_changes.') },
  run: async ({ change, ...args }) => {
    if (change !== undefined) {
      return revertRevision(change)
    }
    const ref = await objectOf(args)
    if (ref === null) {
      throw new ToolRefusal('Name the pack or file, or give the change id.')
    }
    const latest = (await revisions.list(ref, HISTORY_LIMIT)).find((rev) => rev.kind === 'updated')
    if (latest === undefined) {
      throw new ToolRefusal('That has no change to revert.')
    }
    return revertRevision(latest.id)
  },
})

const markChangesSeen = setiTool({
  name: 'mark_changes_seen',
  description: "Mark agents' changes as seen so Seti stops flagging them: one pack or file, or all.",
  input: objectArgs,
  run: async (args) => {
    const ref = await objectOf(args)
    const refs =
      ref === null
        ? (await revisions.unseen()).map(({ object_type, object_id }) => ({ object_type, object_id }))
        : [ref]
    for (const one of refs) {
      await revisions.markSeen(one)
    }
    return done(`Marked the changes to ${String(refs.length)} objects as seen.`)
  },
})

export const CONTEXT_TOOLS = [
  listContextPacks,
  getContextPack,
  createContextPack,
  updateContextPack,
  deleteContextPack,
  listContextFilesTool,
  readContextFileTool,
  writeContextFileTool,
  listChanges,
  revertChange,
  markChangesSeen,
]
