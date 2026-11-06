import type { ModIcon } from '@seti/shared'
import { Puzzle } from 'lucide-react'
import type { ComponentType } from 'react'
import { cn } from '@/lib/utils'
import { MOD_ICONS } from './ModGlyph'

/** A mod's icon as an icon component, for menus and lists that size it themselves. */
export function modIconComponent(icon: ModIcon | null): ComponentType<{ className?: string }> {
  if (icon?.kind === 'image') {
    const { url } = icon
    return function ModImageIcon({ className }: { className?: string }) {
      return <img src={url} alt="" aria-hidden draggable={false} className={cn('object-contain', className)} />
    }
  }
  return icon?.kind === 'lucide' ? (MOD_ICONS[icon.name] ?? Puzzle) : Puzzle
}
