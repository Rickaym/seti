import { CONNECTION_TEMPLATES, templateMatches, type ConnectionTemplate } from '@seti/shared'
import { Search, SlidersHorizontal } from 'lucide-react'
import { useState } from 'react'
import { Hint } from '@/components/Hint'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { TEMPLATE_ICON } from './template-icons'

/** What the template asks for, in a word or two beside its name. */
function needOf(template: ConnectionTemplate): string {
  if (template.kind === 'key') {
    return 'key'
  }
  return template.kind === 'jwt_bearer' ? 'key file' : 'OAuth app'
}

const whereOf = (template: ConnectionTemplate) =>
  [...template.hosts, ...template.parts.map((part) => part.title)].join(', ')

function TemplateRow({ template, onPick }: { template: ConnectionTemplate; onPick: () => void }) {
  const Icon = TEMPLATE_ICON[template.category]
  return (
    <li className="border-b border-border last:border-b-0">
      <button
        type="button"
        aria-label={template.title}
        onClick={onPick}
        className="flex w-full items-start gap-3 px-3 py-2 text-left hover:bg-accent pointer-coarse:min-h-11"
      >
        <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex min-w-0 items-center gap-2">
            <span className="truncate text-sm font-medium">{template.title}</span>
            <span className="ml-auto shrink-0 border border-border px-1 text-2xs leading-4 text-muted-foreground">
              {needOf(template)}
            </span>
          </span>
          <span className="line-clamp-2 text-muted-foreground">{template.description}</span>
          <span className="truncate font-mono text-2xs text-muted-foreground">{whereOf(template)}</span>
        </span>
      </button>
    </li>
  )
}

/** Picks the service to connect by name, or the custom form for one Seti does not list. */
export function TemplatePicker({
  onClose,
  onPick,
  onCustom,
}: {
  onClose: () => void
  onPick: (template: ConnectionTemplate) => void
  onCustom: () => void
}) {
  const [query, setQuery] = useState('')
  const found = CONNECTION_TEMPLATES.filter((template) => templateMatches(template, query.trim()))
  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) {
          onClose()
        }
      }}
    >
      <DialogContent className="flex max-h-[92vh] min-h-0 flex-col gap-0 overflow-hidden border p-0 sm:max-w-2xl">
        <DialogHeader className="border-b border-border px-4 py-3">
          <DialogTitle>Add connection</DialogTitle>
        </DialogHeader>
        <div className="relative border-b border-border px-4 py-2">
          <Search className="pointer-events-none absolute top-1/2 left-6 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            aria-label="Search services"
            placeholder="Search services"
            value={query}
            className="pl-7"
            onChange={(event) => {
              setQuery(event.target.value)
            }}
          />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto text-xs">
          {found.length === 0 ? (
            <p className="px-3 py-4 text-muted-foreground">Nothing matches. Add it as a custom connection.</p>
          ) : (
            <ul aria-label="Services">
              {found.map((template) => (
                <TemplateRow
                  key={template.id}
                  template={template}
                  onPick={() => {
                    onPick(template)
                  }}
                />
              ))}
            </ul>
          )}
        </div>
        <DialogFooter className="border-t border-border px-4 py-3">
          <Hint text="Set the hosts, header and token settings yourself">
            <Button type="button" variant="outline" size="sm" onClick={onCustom}>
              <SlidersHorizontal />
              Custom
            </Button>
          </Hint>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
