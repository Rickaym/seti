import { Save } from 'lucide-react'
import type { ReactNode } from 'react'
import { Hint } from '@/components/Hint'
import { BackButton, DetailHeader, DetailTitle } from '@/components/SplitPane'
import { FindableTextarea } from '@/components/find/FindableTextarea'
import { Button } from '@/components/ui/button'
import { useSaveShortcut } from '@/panels/context/useSaveShortcut'

export function EditorFrame({
  title,
  subtitle,
  dirty,
  canSave,
  saving,
  saveLabel = 'Save',
  readOnly = false,
  onSave,
  actions,
  banner,
  aside,
  children,
}: {
  title: string
  subtitle: string
  dirty: boolean
  canSave: boolean
  saving: boolean
  saveLabel?: string
  /** Hides Save, for what Seti owns. */
  readOnly?: boolean
  onSave: () => void
  actions?: ReactNode
  banner?: ReactNode
  aside?: ReactNode
  children: ReactNode
}) {
  useSaveShortcut(() => {
    if (canSave && !saving && !readOnly) {
      onSave()
    }
  })

  return (
    <div className="flex h-full min-h-0 flex-col">
      <DetailHeader
        actions={
          <>
            {actions}
            {!readOnly && (
              <Hint text={`${saveLabel} (Ctrl+S)`}>
                <Button size="sm" onClick={onSave} disabled={!canSave || saving}>
                  <Save />
                  {saving ? 'Saving...' : saveLabel}
                </Button>
              </Hint>
            )}
          </>
        }
      >
        <div className="flex items-center gap-2">
          <BackButton section="context" label="context" />
          <DetailTitle>{title}</DetailTitle>
          {dirty && (
            <span className="bg-warning/20 px-1.5 py-0.5 text-2xs font-semibold text-foreground uppercase">
              unsaved
            </span>
          )}
        </div>
        <div className="truncate text-xs text-muted-foreground">{subtitle}</div>
      </DetailHeader>
      {banner}
      <div className="flex min-h-0 flex-1">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3 px-5 py-4 max-md:px-3 max-md:py-3">{children}</div>
        {aside}
      </div>
    </div>
  )
}

export function Banner({ tone, children }: { tone: 'info' | 'danger'; children: ReactNode }) {
  const style =
    tone === 'danger' ? 'border-destructive/40 bg-destructive/10 text-destructive' : 'border-border bg-muted/50'
  return (
    <div className={`flex shrink-0 items-center gap-3 border-b px-5 py-2 text-xs ${style}`} role="status">
      {children}
    </div>
  )
}

export function CodeArea({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  placeholder?: string
}) {
  return (
    <FindableTextarea
      aria-label={label}
      spellCheck={false}
      boxClassName="min-h-0 flex-1"
      className="min-h-0 flex-1 resize-none font-mono text-xs leading-relaxed [field-sizing:fixed]"
      value={value}
      placeholder={placeholder}
      onChange={(e) => {
        onChange(e.target.value)
      }}
    />
  )
}
