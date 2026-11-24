import { RefreshCw } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { SharedToolList } from '@/panels/capabilities/SharedToolList'
import { SettingsBody, SettingsHeader } from './layout'

/** The scripts agents proposed and the user allowed, which agents on every runtime load. */
export function SharedToolsPage() {
  const [refreshes, setRefreshes] = useState(0)
  return (
    <SettingsBody
      narrow
      header={
        <SettingsHeader
          title="Shared tools"
          description="Scripts agents proposed and you allowed, as tools for agents on every runtime."
          actions={
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setRefreshes((count) => count + 1)
              }}
            >
              <RefreshCw />
              Refresh
            </Button>
          }
        />
      }
    >
      <div className="text-xs">
        <SharedToolList refreshToken={refreshes} />
      </div>
    </SettingsBody>
  )
}
