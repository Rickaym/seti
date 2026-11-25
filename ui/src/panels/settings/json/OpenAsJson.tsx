import { Braces } from 'lucide-react'
import { useContext } from 'react'
import { Hint } from '@/components/Hint'
import { Button } from '@/components/ui/button'
import { openSettingsCard } from '@/lib/route'
import { jsonCardOf, SettingsPageContext } from './json-card'

/** Opens the JSON page at this settings page's section. */
export function OpenAsJson() {
  const card = jsonCardOf(useContext(SettingsPageContext))
  if (card === null) {
    return null
  }
  return (
    <Hint text="Open these settings as JSON">
      <Button
        size="icon-sm"
        variant="outline"
        aria-label="Open as JSON"
        onClick={() => {
          openSettingsCard('json', card)
        }}
      >
        <Braces />
      </Button>
    </Hint>
  )
}
