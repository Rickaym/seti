import type { Connection, MintTest } from '@seti/shared'
import { FlaskConical } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { apiPost, errorText } from '@/api'
import { Button } from '@/components/ui/button'

/** Mints one token for an OAuth connection and says whether it worked, never the token. */
export function TestMint({ connection, onTested }: { connection: Connection; onTested: () => void }) {
  const [busy, setBusy] = useState(false)
  const test = async () => {
    setBusy(true)
    try {
      const result = await apiPost<MintTest>(`/connections/${connection.id}/test`, {})
      if (result.ok) {
        const until =
          result.expires_at === null ? '' : `, valid until ${new Date(result.expires_at).toLocaleTimeString()}`
        toast.success(`Minted a token${until}`)
      } else {
        toast.error(`Minting failed: ${result.error ?? 'unknown reason'}`)
      }
      onTested()
    } catch (e) {
      toast.error(errorText(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Button size="sm" variant="outline" disabled={busy} onClick={() => void test()}>
      <FlaskConical />
      Test
    </Button>
  )
}
