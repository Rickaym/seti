import type { ClaudeLogins } from '@seti/shared'
import { ArrowLeftRight } from 'lucide-react'
import { useEffect } from 'react'
import { toast } from 'sonner'
import { setLoginMenu } from '@/components/account/login-menu'
import { useCommands } from '@/components/palette/useCommands'
import { CHORDS, useChords } from '@/components/shortcuts/chords'
import { switchLogin } from '@/hooks/useAccount'
import { navigate } from '@/lib/route'

const NOTICED_KEY = 'seti:unsaved-login-noticed'

/** Tells the user once per browser session about a login Claude Code got outside Seti. */
function noticeOnce(email: string): boolean {
  try {
    const seen = new Set((sessionStorage.getItem(NOTICED_KEY) ?? '').split('\n'))
    if (seen.has(email)) {
      return false
    }
    sessionStorage.setItem(NOTICED_KEY, [...seen, email].join('\n'))
  } catch {
    return true
  }
  return true
}

const openAccountSettings = () => {
  navigate('settings', 'account')
}

/** Ctrl+K "Switch to" commands, the Alt chord for the switcher, and the unsaved login notice. */
export function useLoginSwitching(logins: ClaudeLogins | undefined): void {
  const accounts = logins?.accounts ?? []
  const switchable = accounts.filter((login) => login.id !== logins?.active_id)
  useChords([
    {
      chord: CHORDS.switchLogin,
      run: () => {
        if (accounts.length === 0) {
          openAccountSettings()
        } else {
          setLoginMenu(true)
        }
      },
    },
  ])
  useCommands(
    switchable.map((login) => ({
      id: `login.switch.${login.id}`,
      title: `Switch to ${login.name}`,
      ...(login.email === null ? {} : { detail: login.email }),
      icon: ArrowLeftRight,
      group: 'General' as const,
      keywords: 'claude account login use work personal',
      run: () => {
        void switchLogin(login)
      },
    })),
  )
  const unsaved = logins?.unsaved?.email ?? null
  useEffect(() => {
    if (unsaved === null || !noticeOnce(unsaved)) {
      return
    }
    toast(`Claude Code is logged in to ${unsaved}`, {
      description: 'Save this login to switch back to it later.',
      action: { label: 'Save', onClick: openAccountSettings },
    })
  }, [unsaved])
}
