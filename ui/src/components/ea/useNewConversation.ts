import { EA_CLIENT_MESSAGES } from '@seti/shared'
import { useCallback } from 'react'
import { toast } from 'sonner'
import { errorText } from '@/api'
import { useConfirm } from '@/components/ui/confirm-context'
import { useEaCallStore, useEaHistoryStore } from './call-context'

/** Starts a new conversation once the user confirms; the EA forgets the old one, calls too. */
export function useNewConversation(): () => Promise<void> {
  const store = useEaCallStore()
  const history = useEaHistoryStore()
  const confirm = useConfirm()
  return useCallback(async () => {
    const ok = await confirm({
      title: 'Start a new conversation?',
      message: 'The EA forgets everything said so far, on this call and earlier ones.',
      confirmLabel: 'Forget it',
      variant: 'destructive',
    })
    if (!ok) {
      return
    }
    try {
      await history.clear()
      store.clearCaptions()
      store.notify(EA_CLIENT_MESSAGES.historyCleared)
    } catch (e) {
      toast.error('Could not start a new conversation', { description: errorText(e) })
    }
  }, [confirm, history, store])
}
