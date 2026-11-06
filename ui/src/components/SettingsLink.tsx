import type { ReactNode } from 'react'
import { navigate } from '@/lib/route'
import type { SettingsPageKey } from '@/panels/settings/pages'

/** A link to a settings page or an item on it, for hints that name where to fix something. */
export function SettingsLink({
  page,
  detail,
  label,
  children,
}: {
  page: SettingsPageKey
  detail?: string
  /** A fuller accessible name when the visible text is short. */
  label?: string
  children: ReactNode
}) {
  const to = detail === undefined ? page : `${page}/${detail}`
  return (
    <a
      href={`#settings/${to}`}
      aria-label={label}
      className="text-primary underline underline-offset-2 hover:text-foreground"
      onClick={(e) => {
        if (e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey) {
          e.preventDefault()
          navigate('settings', to)
        }
      }}
    >
      {children}
    </a>
  )
}
