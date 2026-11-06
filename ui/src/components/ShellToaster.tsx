import { Toaster } from '@/components/ui/sonner'
import { useCoarsePointer } from '@/hooks/useMedia'
import { useTyping } from '@/hooks/useTypingMode'

/** Clears the status bar, which on touch screens is a 44px row above the home indicator. */
const TOUCH_BOTTOM = 'calc(env(safe-area-inset-bottom) + 3.5rem)'

/** Toasts move to the top while a phone keyboard is up, clear of it and of the reply box. */
export function ShellToaster() {
  const typing = useTyping()
  const bottom = useCoarsePointer() ? TOUCH_BOTTOM : 36
  return (
    <Toaster
      richColors
      closeButton
      position={typing ? 'top-center' : 'bottom-right'}
      offset={{ bottom, right: 'max(16px, env(safe-area-inset-right))' }}
      mobileOffset={{ top: 'max(16px, env(safe-area-inset-top))', bottom }}
    />
  )
}
