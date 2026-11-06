import { CircleCheckIcon, InfoIcon, TriangleAlertIcon, OctagonXIcon, Loader2Icon } from 'lucide-react'
import { Toaster as Sonner, type ToasterProps } from 'sonner'
import { useTheme } from '@/components/theme/theme-context'

/** Sonner's rich colours, read from theme tokens instead of its built-in palette. */
const RICH_COLORS = Object.fromEntries(
  ['success', 'info', 'warning', 'error'].flatMap((type) =>
    ['bg', 'border', 'text'].map((part) => [`--${type}-${part}`, `var(--toast-${type}-${part})`]),
  ),
)

const Toaster = ({ ...props }: ToasterProps) => {
  const { scheme } = useTheme()

  return (
    <Sonner
      theme={scheme}
      className="toaster group"
      icons={{
        success: <CircleCheckIcon className="size-4" />,
        info: <InfoIcon className="size-4" />,
        warning: <TriangleAlertIcon className="size-4" />,
        error: <OctagonXIcon className="size-4" />,
        loading: <Loader2Icon className="size-4 animate-spin" />,
      }}
      style={
        {
          '--normal-bg': 'var(--popover)',
          '--normal-text': 'var(--popover-foreground)',
          '--normal-border': 'var(--border)',
          '--border-radius': 'var(--radius)',
          ...RICH_COLORS,
        } as React.CSSProperties
      }
      toastOptions={{
        classNames: {
          toast: 'cn-toast',
        },
      }}
      {...props}
    />
  )
}

export { Toaster }
