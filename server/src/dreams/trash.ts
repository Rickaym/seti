import fs from 'node:fs'
import path from 'node:path'
import type { DreamProposal, DreamProposalKind, TrashItem } from '@seti/shared'
import { audit } from '../audit.js'
import { TRASH_ROOT } from '../config.js'
import { refuseAgent, refuseDelegates } from '../ea-guard.js'
import { agentGit, mainCheckout } from '../git.js'
import { HttpError } from '../http.js'
import { removeOwnedDir } from '../owned-dirs.js'
import { dreamProposals, trashItems, type TrashMeta } from '../store/dream-proposals.js'
import type { Checked } from './proposal-checks.js'

/** `trash_keep`: how long an allowed clean-up stays restorable. */
const TRASH_KEEP_MS = 14 * 24 * 60 * 60_000
/** `proposal_expiry`: how long a proposal waits for the user. */
const PROPOSAL_EXPIRY_MS = 7 * 24 * 60 * 60_000
const SWEEP_MS = 60 * 60_000

/** A fresh folder in the trash for one item, one level below its root. */
function newSlot(proposalId: number): string {
  fs.mkdirSync(TRASH_ROOT, { recursive: true, mode: 0o700 })
  return fs.mkdtempSync(path.join(TRASH_ROOT, `p${String(proposalId)}-`))
}

/** Moves a path into a trash slot; across disks it refuses rather than copy and delete. */
async function moveIn(from: string, slot: string): Promise<string> {
  const to = path.join(slot, path.basename(from))
  try {
    fs.renameSync(from, to)
  } catch (e) {
    await removeOwnedDir(slot, 'trash', [])
    const crossDisk = (e as NodeJS.ErrnoException).code === 'EXDEV'
    throw new HttpError(409, crossDisk ? `${from} is on another disk than the trash` : `Could not move ${from}`)
  }
  return to
}

/** Applies an allowed clean-up: moves it into the trash, or deletes the branch and keeps its tip. */
export async function applyIntoTrash(
  proposal: DreamProposal & { kind: DreamProposalKind },
  checked: Checked,
): Promise<TrashItem> {
  let meta: TrashMeta = {}
  let trashPath = ''
  if (proposal.kind === 'delete_branch' && checked.branch !== undefined) {
    const tip = await agentGit(checked.path, 'rev-parse', `refs/heads/${checked.branch}`)
    await agentGit(checked.path, 'branch', '-D', '--', checked.branch)
    meta = { repo: checked.path, branch: checked.branch, tip }
  } else {
    const repo = proposal.kind === 'remove_worktree' ? (mainCheckout(checked.path) ?? undefined) : undefined
    trashPath = await moveIn(checked.path, newSlot(proposal.id))
    meta = repo === undefined ? {} : { repo }
  }
  const item = await trashItems.add({
    task_id: proposal.task_id,
    proposal_id: proposal.id,
    kind: proposal.kind,
    original_path: proposal.target,
    trash_path: trashPath,
    bytes: checked.bytes,
    meta,
    purge_after: new Date(Date.now() + TRASH_KEEP_MS).toISOString(),
  })
  await audit.record({
    actor: 'user',
    kind: 'dream.trashed',
    subject_type: 'task',
    subject_id: proposal.task_id,
    summary: `Moved ${proposal.target} into the trash`,
    detail: { proposal: proposal.id, trash: item.id, kind: proposal.kind, target: proposal.target, bytes: item.bytes },
  })
  return item
}

/**
 * Puts a trash item back where it was, or recreates its branch at the kept tip; refused with
 * 409 when the place is taken. The user's, or the EA's after the user's yes; never an agent's.
 */
export async function restoreFromTrash(id: number): Promise<TrashItem> {
  refuseAgent('restore from the trash')
  const found = await trashItems.get(id)
  if (found?.item.restored_at !== null) {
    throw new HttpError(404, 'No such item in the trash')
  }
  const { item, trashPath, meta } = found
  if (item.kind === 'delete_branch' && meta.repo !== undefined && meta.branch !== undefined && meta.tip !== undefined) {
    await agentGit(meta.repo, 'branch', '--', meta.branch, meta.tip).catch(() => {
      throw new HttpError(409, `Branch ${meta.branch ?? ''} exists again or its commit is gone`)
    })
  } else {
    if (fs.existsSync(item.original_path)) {
      throw new HttpError(409, `${item.original_path} is taken; move it away first`)
    }
    fs.renameSync(trashPath, item.original_path)
    await removeOwnedDir(path.dirname(trashPath), 'trash', [])
    if (item.kind === 'remove_worktree') {
      await agentGit(item.original_path, 'worktree', 'repair').catch(() => '')
    }
  }
  await trashItems.restored(item.id)
  await audit.record({
    actor: 'user',
    kind: 'dream.restored',
    subject_type: 'task',
    subject_id: item.task_id,
    summary: `Restored ${item.original_path} from the trash`,
    detail: { trash: item.id, target: item.original_path, bytes: item.bytes },
  })
  return { ...item, restored_at: new Date().toISOString() }
}

/** Removes trash items for good: those past `trash_keep`, or every one when `all`. */
async function purgeTrash(all: boolean): Promise<{ count: number; bytes: number }> {
  let count = 0
  let bytes = 0
  for (const row of await trashItems.due(all ? null : new Date().toISOString())) {
    const refusal = row.trash_path === '' ? null : await removeOwnedDir(path.dirname(row.trash_path), 'trash', [])
    if (refusal === null) {
      await trashItems.purged(row.id)
      count += 1
      bytes += Number(row.bytes)
    }
  }
  if (count > 0) {
    await audit.record({
      actor: all ? 'user' : 'system',
      kind: 'dream.trash_purged',
      subject_type: 'system',
      summary: `Removed ${String(count)} items from the trash for good`,
      detail: { count, bytes },
    })
  }
  return { count, bytes }
}

/** Empties the trash now; only the user does that. */
export async function emptyTrash(): Promise<{ count: number; bytes: number }> {
  refuseDelegates('empty the trash')
  return purgeTrash(true)
}

/** Every hour: expires proposals nobody answered and purges trash past its keep. */
export function startTrashSweep(): void {
  const sweep = () => {
    void dreamProposals
      .expire(new Date(Date.now() - PROPOSAL_EXPIRY_MS).toISOString())
      .then(async () => purgeTrash(false))
      .catch((e: unknown) => {
        process.stderr.write(`dreams: the trash sweep failed: ${e instanceof Error ? e.message : String(e)}\n`)
      })
  }
  setInterval(sweep, SWEEP_MS).unref()
}
