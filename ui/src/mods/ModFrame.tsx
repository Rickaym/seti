import type { ModFileViewProps } from '@seti/mod-api'
import { type ModBridgeOut, type ModFrameInfo, type ModFrameKind, MOD_BRIDGE_LIMITS } from '@seti/shared'
import { ExternalLink, Package, RotateCw } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { apiGet, errorText } from '@/api'
import { Button } from '@/components/ui/button'
import { useConfirm } from '@/components/ui/confirm-context'
import { useNarrow } from '@/hooks/useMedia'
import { cn } from '@/lib/utils'
import { useFrameBridge } from './useFrameBridge'

/** Where Seti placed the frame; the view reads it from its context. */
type FramePlace = 'section' | 'agentTab' | 'sidePanel' | 'fileViewer'

export interface ModFrameProps {
  modId: string
  modName: string
  kind: ModFrameKind
  /** The view's or viewer's id. */
  name: string
  title: string
  place: FramePlace
  phone: boolean
  agentId?: string
  /** The file a viewer shows. */
  file?: ModFileViewProps
}

/** Seti's strip above every mod frame, so a view can never pass itself off as Seti. */
function Chrome({ modName, title, children }: { modName: string; title: string; children: ReactNode }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col" role="region" aria-label={`${modName} mod: ${title}`}>
      <div className="flex h-8 shrink-0 items-center gap-1.5 border-b border-border px-3 text-xs">
        <Package className="size-3.5 text-muted-foreground" aria-hidden />
        <span className="font-medium">{modName}</span>
        <span className="rounded-sm bg-muted px-1 text-2xs text-muted-foreground uppercase">mod</span>
        <span className="truncate text-muted-foreground">{title}</span>
      </div>
      {children}
    </div>
  )
}

/** A line in place of the frame, with Reload where the user can try again. */
function Notice({ text, onReload }: { text: string; onReload?: () => void }) {
  return (
    <div className="flex flex-1 flex-col items-start gap-2 p-4 text-sm text-muted-foreground">
      <p role="status">{text}</p>
      {onReload !== undefined && (
        <Button variant="outline" size="sm" onClick={onReload}>
          <RotateCw />
          Reload
        </Button>
      )}
    </div>
  )
}

/** The file a viewer shows, as text or base64, up to the bridge's file limit. */
async function fileMessage(file: ModFileViewProps): Promise<ModBridgeOut> {
  if (file.text !== null) {
    return { t: 'file', name: file.name, text: file.text.slice(0, MOD_BRIDGE_LIMITS.fileBytes) }
  }
  const bytes = new Uint8Array(await (await fetch(file.url)).arrayBuffer()).slice(0, MOD_BRIDGE_LIMITS.fileBytes)
  let binary = ''
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }
  return { t: 'file', name: file.name, base64: btoa(binary) }
}

function FrameBody(props: ModFrameProps & { hash: string; narrow: boolean; onReload: () => void }) {
  const { modId, modName, kind, name, title, place, narrow, agentId, file, hash } = props
  const confirm = useConfirm()
  const frame = useRef<HTMLIFrameElement>(null)
  const [height, setHeight] = useState<number | null>(null)
  const context: ModBridgeOut = {
    t: 'context',
    mod: modId,
    view: name,
    place,
    phone: narrow,
    ...(agentId === undefined ? {} : { agentId }),
    ...(file === undefined ? {} : { file: { name: file.name, size: file.text?.length ?? 0 } }),
  }
  const bridge = useFrameBridge(frame, {
    modId,
    modName,
    view: name,
    context,
    resize: (next) => {
      if (place === 'fileViewer') {
        setHeight(next)
      }
    },
    link: (url) => {
      const host = new URL(url).hostname
      void confirm({
        title: 'Open link',
        message: `Open ${host} in a new tab?`,
        detail: `${modName}'s ${title} view asks to open ${url}`,
        confirmLabel: 'Open',
        icon: ExternalLink,
      }).then((yes) => {
        if (yes) {
          window.open(url, '_blank', 'noopener,noreferrer')
        }
      })
    },
    onReady: (send) => {
      if (file !== undefined) {
        void fileMessage(file).then(send)
      }
    },
  })
  if (bridge.stopped !== null) {
    return <Notice text={`${bridge.stopped}.`} onReload={props.onReload} />
  }
  const src = `/api/mod-frames/${modId}/${kind}/${name}?v=${hash}#n=${bridge.nonce}`
  return (
    <div className="relative flex min-h-0 flex-1 flex-col overflow-auto">
      {!bridge.ready && (
        <p className="pointer-events-none absolute top-2 left-3 text-2xs text-muted-foreground" aria-live="polite">
          Loading
        </p>
      )}
      <iframe
        ref={frame}
        src={src}
        title={`${modName}: ${title}`}
        sandbox="allow-scripts"
        allow=""
        referrerPolicy="no-referrer"
        onLoad={bridge.loaded}
        style={height === null ? undefined : { height }}
        className={cn('block w-full border-0 bg-background', height === null ? 'min-h-0 flex-1' : 'shrink-0')}
      />
    </div>
  )
}

/**
 * A third-party mod's page in a sandboxed frame inside Seti's chrome. It has no origin, no
 * network and only its own scripts; it reaches Seti through the bridge alone.
 */
export function ModFrame(props: ModFrameProps) {
  const narrow = useNarrow()
  const [instance, setInstance] = useState(0)
  const [info, setInfo] = useState<{ hash: string } | { error: string } | null>(null)
  useEffect(() => {
    let live = true
    apiGet<ModFrameInfo>(`/mod-frames/${props.modId}`)
      .then((found) => {
        if (live) {
          setInfo({ hash: found.hash })
        }
      })
      .catch((e: unknown) => {
        if (live) {
          setInfo({ error: errorText(e) })
        }
      })
    return () => {
      live = false
    }
  }, [props.modId, instance])
  const reload = () => {
    setInstance((n) => n + 1)
  }
  let body: ReactNode
  if (!props.phone && narrow) {
    body = <Notice text={`${props.modName}'s ${props.title} view opens on a larger screen.`} />
  } else if (info === null) {
    body = <Notice text="Loading" />
  } else if ('error' in info) {
    body = <Notice text={`${props.modName}'s view did not open: ${info.error}`} onReload={reload} />
  } else {
    body = (
      <FrameBody
        key={`${String(instance)}-${info.hash}`}
        {...props}
        hash={info.hash}
        narrow={narrow}
        onReload={reload}
      />
    )
  }
  return (
    <Chrome modName={props.modName} title={props.title}>
      {body}
    </Chrome>
  )
}
