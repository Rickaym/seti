import path from 'node:path'
import type { Mount } from './sandbox-mounts.js'

/** The folders a maintenance session may write, besides its own home and /tmp. */
export interface ReadOnlyWork {
  /** The agent's own memory folder, as the host sees it and as the sandbox sees it. */
  memory: { src: string; dest: string } | null
  /** Further folders, mounted at their host path. */
  writable: readonly string[]
}

const inside = (child: string, parent: string) => child === parent || child.startsWith(`${parent}/`)

/**
 * A maintenance session's own mounts: every work folder, cache, workspace and Claude Code folder
 * read-only, then the memory folder and the folders named writable over them. A writable folder
 * under a hidden path is refused, since mounting it would show what the mask covers.
 */
export function readOnlyWork(mounts: readonly Mount[], work: ReadOnlyWork, hidden: readonly string[]): Mount[] {
  const memory = work.memory === null ? [] : [work.memory]
  const open = [...memory, ...work.writable.map((dir) => ({ src: dir, dest: dir }))]
  for (const { src } of open) {
    if (!path.isAbsolute(src) || hidden.some((secret) => inside(src, secret))) {
      throw new Error(`A maintenance session cannot write ${src}`)
    }
  }
  return [
    ...mounts.map((mount): Mount => (mount.kind === 'bind' ? { ...mount, kind: 'ro-bind' } : mount)),
    ...open.map((dir): Mount => ({ kind: 'bind', src: dir.src, dest: dir.dest })),
  ]
}
