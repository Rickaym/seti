import type { ModKit } from '@seti/mod-api'
import { setVimHelpOpen, useVimActive, useVimMode } from './vim-store'

/** NORMAL or INSERT while Vim keys act; pressing it lists the keys. */
export const modeItem = ({ StatusItem, StatusHint }: ModKit) =>
  function VimModeItem() {
    const active = useVimActive()
    const mode = useVimMode()
    if (!active) {
      return null
    }
    const label = mode === 'normal' ? 'NORMAL' : 'INSERT'
    return (
      <StatusItem
        label={`Vim mode ${label}`}
        name="Vim"
        tone="muted"
        tooltip={
          <StatusHint title={`Vim mode: ${label.toLowerCase()}`}>
            <span>
              {mode === 'normal'
                ? 'Keys move between panels and scroll them; i writes, ? lists the keys.'
                : 'Keys type; Esc returns to normal mode, except in a terminal.'}
            </span>
          </StatusHint>
        }
        onClick={() => {
          setVimHelpOpen(true)
        }}
      >
        <span data-testid="vim-mode" className="font-mono tracking-wider">
          {label}
        </span>
      </StatusItem>
    )
  }
