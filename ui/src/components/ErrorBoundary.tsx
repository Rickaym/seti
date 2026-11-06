import { Copy, RotateCw, TriangleAlert } from 'lucide-react'
import { Component, Fragment, type ErrorInfo, type ReactNode } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

/** panel fills its area, row is one transcript line, item a status bar slot, inline a block. */
type FallbackKind = 'panel' | 'row' | 'item' | 'inline'

interface Props {
  /** What crashed, in the user's words, such as "Team chat"; also names it in the log. */
  name: string
  kind?: FallbackKind
  /** A change, such as another route, clears the crash and renders the children again. */
  resetKey?: unknown
  className?: string
  children: ReactNode
}

interface State {
  error: Error | null
  componentStack: string
  /** Bumped by Reload so the children mount from scratch. */
  attempt: number
}

const asError = (value: unknown) => (value instanceof Error ? value : new Error(String(value)))

function details(name: string, error: Error, componentStack: string): string {
  return [`${name}: ${error.message}`, error.stack ?? '', componentStack.trim()]
    .filter((part) => part !== '')
    .join('\n\n')
}

function copyDetails(text: string): void {
  navigator.clipboard.writeText(text).then(
    () => toast.success('Details copied'),
    () => toast.error('Copy failed; select the text instead'),
  )
}

interface FallbackProps {
  name: string
  kind: FallbackKind
  error: Error
  componentStack: string
  className: string | undefined
  onReload: () => void
}

function ErrorText({ error }: { error: Error }) {
  return (
    <pre className="mt-1 max-h-40 overflow-auto bg-muted p-2 font-mono text-2xs break-all whitespace-pre-wrap text-muted-foreground">
      {error.message}
    </pre>
  )
}

function ItemFallback({ name, onReload }: Pick<FallbackProps, 'name' | 'onReload'>) {
  return (
    <button
      type="button"
      aria-label={`${name} could not be shown. Reload it`}
      title={`${name} could not be shown. Click to reload it.`}
      className="flex h-full items-center px-2 text-destructive outline-none hover:bg-foreground/10 focus-visible:bg-foreground/10"
      onClick={onReload}
    >
      <TriangleAlert className="size-3" aria-hidden />
    </button>
  )
}

function RowFallback({ name, error, componentStack, className }: Omit<FallbackProps, 'kind' | 'onReload'>) {
  return (
    <div role="note" className={cn('text-xs text-muted-foreground', className)}>
      <details>
        <summary className="flex cursor-pointer items-center gap-2">
          <TriangleAlert className="size-3.5 shrink-0 text-destructive" aria-hidden />
          <span>This message could not be shown.</span>
        </summary>
        <ErrorText error={error} />
        <Button
          size="xs"
          variant="ghost"
          className="mt-1"
          onClick={() => {
            copyDetails(details(name, error, componentStack))
          }}
        >
          <Copy />
          Copy details
        </Button>
      </details>
    </div>
  )
}

function PanelFallback({ name, kind, error, componentStack, className, onReload }: FallbackProps) {
  return (
    <div
      role="alert"
      className={cn(
        'flex min-w-0 flex-col gap-2 text-xs',
        kind === 'panel' ? 'h-full justify-center overflow-y-auto p-6' : 'p-3',
        className,
      )}
    >
      <div className={cn('flex w-full min-w-0 flex-col gap-2', kind === 'panel' && 'mx-auto max-w-lg')}>
        <p className="flex items-center gap-2 text-sm font-medium">
          <TriangleAlert className="size-4 shrink-0 text-destructive" aria-hidden />
          {name} could not be shown.
        </p>
        <p className="text-muted-foreground">The rest of Seti still works. Reload this panel to try again.</p>
        <details>
          <summary className="cursor-pointer text-muted-foreground">Error details</summary>
          <ErrorText error={error} />
        </details>
        <div className="flex flex-wrap gap-1.5">
          <Button size="sm" variant="outline" onClick={onReload}>
            <RotateCw />
            Reload this panel
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              copyDetails(details(name, error, componentStack))
            }}
          >
            <Copy />
            Copy details
          </Button>
        </div>
      </div>
    </div>
  )
}

/** Keeps a render crash inside one area, with a way to reload it, instead of blanking the app. */
export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null, componentStack: '', attempt: 0 }

  static getDerivedStateFromError(error: unknown): Partial<State> {
    return { error: asError(error) }
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    const componentStack = info.componentStack ?? ''
    this.setState({ componentStack })
    // eslint-disable-next-line no-console -- crashes are reported to the browser console
    console.error(`Seti could not render ${this.props.name}:`, asError(error), componentStack)
  }

  override componentDidUpdate(previous: Props): void {
    if (this.state.error !== null && !Object.is(previous.resetKey, this.props.resetKey)) {
      this.reload()
    }
  }

  reload = (): void => {
    this.setState((state) => ({ error: null, componentStack: '', attempt: state.attempt + 1 }))
  }

  override render(): ReactNode {
    const { error, componentStack, attempt } = this.state
    const { name, kind = 'panel', className, children } = this.props
    if (error === null) {
      return <Fragment key={attempt}>{children}</Fragment>
    }
    if (kind === 'item') {
      return <ItemFallback name={name} onReload={this.reload} />
    }
    if (kind === 'row') {
      return <RowFallback name={name} error={error} componentStack={componentStack} className={className} />
    }
    return (
      <PanelFallback
        name={name}
        kind={kind}
        error={error}
        componentStack={componentStack}
        className={className}
        onReload={this.reload}
      />
    )
  }
}
