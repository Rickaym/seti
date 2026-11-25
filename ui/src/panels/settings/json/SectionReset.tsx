import { patchOf, pathText, type SettingsDoc } from '@seti/shared'
import { RotateCcw } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { PreviewDialog } from './PreviewDialog'
import { resettable, shown, type ChangeRow } from './json-edit'
import type { DocSection } from './settings-json'
import { useWrite } from './use-write'

/** Reset on a section's card: pick a setting that differs from its default and set it back. */
export function SectionReset({
  doc,
  section,
  onSaved,
}: {
  doc: SettingsDoc
  section: DocSection
  onSaved: () => void
}) {
  const [open, setOpen] = useState(false)
  const write = useWrite(onSaved, (refusal) => {
    toast.error(refusal.detail, { duration: Infinity })
  })
  const rows = resettable(section)
  if (rows.length === 0) {
    return null
  }
  const pick = (row: ChangeRow) => {
    setOpen(false)
    write.open({
      rows: [row],
      body: {
        base_revision: doc.revision,
        patch: patchOf(row.path, row.after) as Record<string, unknown>,
        expect: [{ path: [...row.path], value: row.before }],
        confirm: [],
      },
    })
  }
  return (
    <>
      <Button
        size="xs"
        variant="ghost"
        aria-label={`Reset ${section.path}`}
        onClick={() => {
          setOpen(true)
        }}
      >
        <RotateCcw />
        Reset
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="gap-3 sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Reset to default</DialogTitle>
          </DialogHeader>
          <ul aria-label="Modified settings" className="max-h-[60vh] overflow-y-auto">
            {rows.map((row) => (
              <li
                key={pathText(row.path)}
                className="flex items-center gap-2 border-b border-border py-2 last:border-b-0"
              >
                <div className="min-w-0 flex-1 space-y-0.5">
                  <div className="font-mono text-xs font-medium wrap-anywhere">{pathText(row.path.slice(2))}</div>
                  <div className="font-mono text-xs wrap-anywhere text-muted-foreground">
                    default {shown(row.after)}
                  </div>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  aria-label={`Reset ${pathText(row.path)}`}
                  onClick={() => {
                    pick(row)
                  }}
                >
                  <RotateCcw />
                  Reset
                </Button>
              </li>
            ))}
          </ul>
        </DialogContent>
      </Dialog>
      {write.planned !== null && (
        <PreviewDialog
          rows={write.planned.rows}
          confirm={write.confirm}
          busy={write.busy}
          onSave={() => void write.save()}
          onClose={write.close}
        />
      )}
    </>
  )
}
