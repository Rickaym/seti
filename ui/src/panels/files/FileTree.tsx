import type { FileRoot, TreeEntry } from '@seti/shared'
import { HardDrive } from 'lucide-react'
import { useState } from 'react'
import type { ListedEntry } from '@/panels/files/FileList'
import { TreeRow } from '@/panels/files/TreeRow'
import { FILE_ICONS, fileLook } from '@/panels/files/file-icon'
import { useTreeFolder, type TreeFolder, type TreeQuery } from '@/panels/files/useTreeFolder'

/** What every node of one tree shares: the agent, the panel's toggles and the file opener. */
interface TreeContext extends Omit<TreeQuery, 'root' | 'path' | 'enabled'> {
  onOpenFile: (entry: ListedEntry) => void
}

const note = (text: string, level: number) => (
  <li className="py-1.5 pr-3 text-xs text-muted-foreground" style={{ paddingLeft: 8 + Math.min(level, 8) * 12 + 22 }}>
    {text}
  </li>
)

function Children({ folder, root, level, ctx }: { folder: TreeFolder; root: string; level: number; ctx: TreeContext }) {
  if (folder.error !== null) {
    return <ul role="group">{note(folder.error, level)}</ul>
  }
  if (folder.listing === null) {
    return <ul role="group">{note('Loading...', level)}</ul>
  }
  const { entries, truncated } = folder.listing
  return (
    <ul role="group">
      {entries.length === 0 && note('Empty folder', level)}
      {entries.map((entry) =>
        entry.type === 'dir' ? (
          <FolderNode key={entry.path} entry={entry} root={root} level={level} ctx={ctx} />
        ) : (
          <FileNode key={entry.path} entry={entry} root={root} level={level} ctx={ctx} />
        ),
      )}
      {truncated && note('More entries than the tree shows', level)}
    </ul>
  )
}

interface NodeProps {
  entry: TreeEntry
  root: string
  level: number
  ctx: TreeContext
}

function FolderNode({ entry, root, level, ctx }: NodeProps) {
  const [open, setOpen] = useState(false)
  const folder = useTreeFolder({ ...ctx, root, path: entry.path, enabled: open })
  return (
    <li>
      <TreeRow
        name={entry.name}
        icon={FILE_ICONS[fileLook(entry.name, 'dir')]}
        level={level}
        expanded={open}
        size={entry.size}
        mtime={entry.mtime}
        git={entry.git}
        rebuildable={entry.rebuildable}
        onClick={() => {
          setOpen(!open)
        }}
      />
      {open && <Children folder={folder} root={root} level={level + 1} ctx={ctx} />}
    </li>
  )
}

function FileNode({ entry, root, level, ctx }: NodeProps) {
  return (
    <li>
      <TreeRow
        name={entry.name}
        icon={FILE_ICONS[fileLook(entry.name, 'file')]}
        level={level}
        expanded={null}
        size={entry.size}
        mtime={entry.mtime}
        git={null}
        rebuildable={false}
        onClick={() => {
          ctx.onOpenFile({ ...entry, root, type: 'file', size: entry.size?.bytes ?? 0 })
        }}
      />
    </li>
  )
}

/** A root at the top of the tree, loaded at once so its total size shows while it is closed. */
function RootNode({ root, ctx }: { root: FileRoot; ctx: TreeContext }) {
  const [open, setOpen] = useState(false)
  const folder = useTreeFolder({ ...ctx, root: root.id, path: '', enabled: true })
  return (
    <li>
      <TreeRow
        name={root.label}
        icon={HardDrive}
        level={0}
        expanded={open}
        size={folder.listing?.size ?? null}
        mtime={null}
        git={null}
        rebuildable={false}
        title={root.path}
        onClick={() => {
          setOpen(!open)
        }}
      />
      {open && <Children folder={folder} root={root.id} level={1} ctx={ctx} />}
    </li>
  )
}

interface FileTreeProps extends TreeContext {
  roots: readonly FileRoot[]
}

/** Every root of the agent as one collapsible tree, each folder with its size and git state. */
export function FileTree({ roots, ...ctx }: FileTreeProps) {
  const shown = roots.filter((root) => root.exists)
  if (shown.length === 0) {
    return <p className="p-4 text-sm text-muted-foreground">This agent has no folders on disk.</p>
  }
  return (
    <ul aria-label="Folder tree" className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto">
      {shown.map((root) => (
        <RootNode key={root.id} root={root} ctx={ctx} />
      ))}
    </ul>
  )
}
