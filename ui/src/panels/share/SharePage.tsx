import { House, Share2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { navigate } from '@/lib/route'
import { shareInbox, type Share } from '@/lib/share-inbox'
import { ShareForm } from '@/panels/share/ShareForm'

function NothingShared() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
      <Share2 className="size-6 text-muted-foreground" aria-hidden />
      <h1 className="text-base font-semibold">Nothing to share</h1>
      <p className="max-w-sm text-sm text-muted-foreground">
        Share files, text or a link to Seti from another app&apos;s share menu, and they wait here for a message.
      </p>
      <Button
        variant="outline"
        className="pointer-coarse:min-h-11"
        onClick={() => {
          navigate('home')
        }}
      >
        <House />
        Home
      </Button>
    </div>
  )
}

/** `#share`: what the share sheet sent, kept on this device until it is sent or cancelled. */
export function SharePage() {
  const [share, setShare] = useState<Share | null | undefined>(undefined)
  useEffect(() => {
    let live = true
    const settle = (next: Share | null) => {
      if (live) {
        setShare(next)
      }
    }
    shareInbox.read().then(settle, () => {
      settle(null)
    })
    return () => {
      live = false
    }
  }, [])
  if (share === undefined) {
    return <div className="p-6 text-sm text-muted-foreground">Loading...</div>
  }
  return share === null ? <NothingShared /> : <ShareForm key={share.manifest.id} share={share} />
}
