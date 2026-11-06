import type { ComponentProps, ReactNode } from 'react'
import { BackButton } from '@/components/SplitPane'
import { PageHeader, PageLayout } from '@/components/crud/PageHeader'
import { cn } from '@/lib/utils'

/** Back to the list of settings pages, on phones where a page fills the screen. */
function SettingsBack() {
  return <BackButton section="settings" label="settings" />
}

export function SettingsHeader(props: Omit<ComponentProps<typeof PageHeader>, 'back' | 'level'>) {
  return <PageHeader {...props} level={2} back={<SettingsBack />} />
}

/** A settings page: its header, then a body that scrolls; `narrow` caps forms. */
export function SettingsBody(props: ComponentProps<typeof PageLayout>) {
  return <PageLayout {...props} />
}

export function SettingsCard({
  id,
  title,
  actions,
  children,
}: {
  /** An anchor for links and redirects that point at this card. */
  id?: string
  title: string
  actions?: ReactNode
  children: ReactNode
}) {
  return (
    <section id={id} aria-label={title} className="scroll-mt-4 border border-border bg-card text-xs">
      <div className="flex min-h-9 items-center justify-between gap-3 border-b border-border px-3 py-2 max-[48rem]:flex-wrap max-[48rem]:gap-y-1">
        <h3 className="min-w-0 text-sm font-semibold wrap-anywhere">{title}</h3>
        {actions !== undefined && <div className="flex items-center gap-3 max-[48rem]:ml-auto">{actions}</div>}
      </div>
      {children}
    </section>
  )
}

/** A page's main list, framed like a card; the page header above names it and holds its actions. */
export function SettingsList({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section aria-label={label} className="border border-border bg-card text-xs">
      {children}
    </section>
  )
}

/** One setting with its control on the right; `stack` puts the control below it on phones. */
export function SettingRow({
  label,
  description,
  stack = false,
  id,
  marked = false,
  children,
}: {
  label: string
  description?: ReactNode
  stack?: boolean
  id?: string
  /** The row a link pointed at, shaded so the eye finds it. */
  marked?: boolean
  children: ReactNode
}) {
  return (
    <div
      id={id}
      className={cn(
        'flex items-center justify-between gap-6 border-b border-border px-3 py-3 last:border-b-0 max-md:gap-3',
        stack && 'max-md:flex-col max-md:items-stretch max-md:gap-2',
        marked && 'bg-accent',
      )}
    >
      <div className="min-w-0">
        <div className="text-sm font-medium">{label}</div>
        {description !== undefined && <div className="mt-0.5 text-muted-foreground">{description}</div>}
      </div>
      <div className={cn('flex min-w-0 shrink-0 flex-wrap items-center gap-2', stack && 'max-md:shrink')}>
        {children}
      </div>
    </div>
  )
}
