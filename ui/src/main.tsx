import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { ShellToaster } from '@/components/ShellToaster'
import { SignInGate } from '@/components/SignIn'
import { EaCallProvider } from '@/components/ea/EaCallProvider'
import { ShortcutProvider } from '@/components/shortcuts/ShortcutProvider'
import { TeamChatProvider } from '@/components/team/TeamChatProvider'
import { ThemeProvider } from '@/components/theme/theme-provider'
import { ConfirmProvider } from '@/components/ui/confirm-dialog'
import { TooltipProvider } from '@/components/ui/tooltip'
import { registerServiceWorker } from '@/lib/service-worker'
import { installThemeTokens } from '@/mods/themes'
import { App } from './App'
import './App.css'

installThemeTokens()

const rootEl = document.getElementById('root')
if (!rootEl) {
  throw new Error('Root element #root not found')
}

// ErrorBoundary logs each crash it catches with the name of the area, so React need not.
createRoot(rootEl, { onCaughtError: () => undefined }).render(
  <StrictMode>
    <ThemeProvider>
      <ShortcutProvider>
        <TooltipProvider delayDuration={200}>
          <SignInGate>
            <ConfirmProvider>
              <EaCallProvider>
                <TeamChatProvider>
                  <App />
                </TeamChatProvider>
              </EaCallProvider>
              <ShellToaster />
            </ConfirmProvider>
          </SignInGate>
        </TooltipProvider>
      </ShortcutProvider>
    </ThemeProvider>
  </StrictMode>,
)

if (import.meta.env.PROD) {
  registerServiceWorker()
}
