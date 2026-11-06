import type { ModFileViewProps, ModKit } from '@seti/mod-api'
import { Zap } from 'lucide-react'
import { useState } from 'react'

/** Pages whose scripts the user turned on, for this page's life only: nothing is stored. */
const scriptsOn = new Set<string>()

/** The page's link without its version, so the choice outlives edits to the file. */
function fileKey(url: string): string {
  const link = new URL(url, window.location.href)
  link.searchParams.delete('v')
  return link.toString()
}

function withScripts(url: string): string {
  const link = new URL(url, window.location.href)
  link.searchParams.set('scripts', '1')
  return link.toString()
}

const SCRIPTS_HINT =
  "Lets the page run its scripts. They still can't reach Seti or load from the web, but WebRTC can reach the network."

/** An HTML file in a sandboxed frame with no origin of its own, no network and scripts off. */
export const pageView = (kit: ModKit) =>
  function HtmlPreview({ page, name, text }: ModFileViewProps) {
    const url = page ?? ''
    const key = fileKey(url)
    const [scripts, setScripts] = useState(() => scriptsOn.has(key))
    const toggle = (on: boolean) => {
      if (on) {
        scriptsOn.add(key)
      } else {
        scriptsOn.delete(key)
      }
      setScripts(on)
    }
    const hasScripts = text !== null && /<script[\s>]/i.test(text)
    const note =
      !scripts && hasScripts
        ? 'This page has scripts, which are off. Turn on Scripts to run them.'
        : "Previewed offline: web links, remote scripts and images don't load."
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <kit.ViewerActions>
          <kit.ToggleButton
            pressed={scripts}
            onPressedChange={toggle}
            icon={<Zap />}
            label="Scripts"
            iconOnly
            hint={scripts ? 'Turn the page scripts off' : SCRIPTS_HINT}
          />
        </kit.ViewerActions>
        <p className="shrink-0 border-b border-border px-4 py-1 text-2xs text-muted-foreground">{note}</p>
        {/* Canvas in the light scheme is the white a browser tab gives a page without a background. */}
        <iframe
          key={String(scripts)}
          src={scripts ? withScripts(url) : url}
          title={`Preview of ${name}`}
          sandbox={scripts ? 'allow-scripts' : ''}
          referrerPolicy="no-referrer"
          className="block min-h-0 w-full flex-1 border-0 bg-[Canvas] scheme-light"
        />
      </div>
    )
  }
