import type { ModKit } from '@seti/mod-api'
import { Fragment } from 'react'
import { BINDINGS } from './keymap'
import { setVimHelpOpen, useVimHelpOpen } from './vim-store'

/** Every Vim mode key, opened with `?` in normal mode or from the status item. */
export const cheatSheet = ({ Dialog }: ModKit) =>
  function VimCheatSheet() {
    const open = useVimHelpOpen()
    return (
      <Dialog open={open} onOpenChange={setVimHelpOpen} title="Vim mode keys" className="sm:max-w-md">
        <div className="flex flex-col gap-3 font-mono text-xs">
          {BINDINGS.map((group) => (
            <section key={group.heading} aria-label={group.heading}>
              <h3 className="mb-1 text-2xs tracking-wider text-muted-foreground uppercase">{group.heading}</h3>
              <dl className="grid grid-cols-[8rem_1fr] gap-x-3 gap-y-1">
                {group.rows.map((row) => (
                  <Fragment key={`${group.heading}-${row.keys}`}>
                    <dt>
                      <kbd>{row.keys}</kbd>
                    </dt>
                    <dd className="text-muted-foreground">{row.action}</dd>
                  </Fragment>
                ))}
              </dl>
            </section>
          ))}
          <p className="text-muted-foreground">
            A terminal takes every other key, Esc included; Ctrl+\ twice sends one Ctrl+\. Keys rest while you type in a
            field.
          </p>
        </div>
      </Dialog>
    )
  }
