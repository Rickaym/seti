import { useMemo, type ReactNode } from 'react'
import { MarkdownImagesContext, relativeAsset, type ImageSource } from '@/components/markdown-images'
import { rawUrl, type FileTarget } from '@/panels/files/files-api'

interface Props {
  taskId: string
  target: FileTarget
  dotfiles: boolean
  children: ReactNode
}

/** Loads the images a Markdown file links relative to its folder, through Files. */
export function FileImages({ taskId, target, dotfiles, children }: Props) {
  const { root, path: base } = target
  const images = useMemo<ImageSource>(
    () => (src) => {
      const path = relativeAsset(base, src)
      return path === null ? null : rawUrl(taskId, { root, path }, { dotfiles })
    },
    [taskId, root, base, dotfiles],
  )
  return <MarkdownImagesContext value={images}>{children}</MarkdownImagesContext>
}
