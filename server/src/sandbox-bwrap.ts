import type { Mount } from './sandbox-mounts.js'

function mountArgs(mount: Mount): string[] {
  switch (mount.kind) {
    case 'bind':
      return ['--bind', mount.src, mount.dest]
    case 'ro-bind':
      return ['--ro-bind', mount.src, mount.dest]
    case 'tmpfs':
      return ['--tmpfs', mount.dest]
    case 'mask':
      return ['--ro-bind', '/dev/null', mount.dest]
    case 'symlink':
      return ['--symlink', mount.target, mount.dest]
  }
}

/**
 * bwrap arguments: fresh pid, network, ipc and uts namespaces, then the mounts. An interactive
 * command keeps its terminal as the controlling one: it holds a pseudo-terminal of its own that
 * no process outside the sandbox reads, so the new session that guards a shared one is left out.
 */
export function bwrapArgs(mounts: readonly Mount[], cwd: string, interactive = false): string[] {
  return [
    '--unshare-user',
    '--unshare-pid',
    '--unshare-net',
    '--unshare-ipc',
    '--unshare-uts',
    '--hostname',
    'seti-sandbox',
    '--die-with-parent',
    ...(interactive ? [] : ['--new-session']),
    '--proc',
    '/proc',
    '--dev',
    '/dev',
    ...mounts.flatMap(mountArgs),
    '--chdir',
    cwd,
  ]
}
