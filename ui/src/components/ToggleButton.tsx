import type { LucideIcon } from 'lucide-react'
import { isValidElement, type ReactElement, type ReactNode } from 'react'
import { Hint } from '@/components/Hint'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { WIDE_BUTTON, WIDE_LABEL } from '@/lib/wide-label'

/** An on/off mode shown as one pressed or unpressed button, like ClickUp's Me Mode. */
export function ToggleButton({
  pressed,
  onPressedChange,
  icon: Icon,
  label,
  hint,
  iconOnly = false,
  wideLabel = false,
  disabled = false,
  size = 'sm',
  variant = 'outline',
}: {
  pressed: boolean
  onPressedChange: (pressed: boolean) => void
  icon: LucideIcon | ReactElement
  label: string
  hint: ReactNode
  /** Show the icon alone, with the label kept for screen readers and the hint. */
  iconOnly?: boolean
  /** With `iconOnly`, show the label as well once the agent pane is wide. */
  wideLabel?: boolean
  disabled?: boolean
  /** xs sits beside other xs controls in a dense row. */
  size?: 'sm' | 'xs'
  /** ghost matches the borderless icon buttons of the agent header. */
  variant?: 'outline' | 'ghost'
}) {
  return (
    <Hint text={hint}>
      <Button
        variant={variant}
        size={iconOnly ? `icon-${size}` : size}
        aria-label={iconOnly ? label : undefined}
        aria-pressed={pressed}
        disabled={disabled}
        onClick={() => {
          onPressedChange(!pressed)
        }}
        className={cn(
          'aria-pressed:border-primary aria-pressed:bg-primary/10 aria-pressed:text-primary dark:aria-pressed:border-primary dark:aria-pressed:bg-primary/20',
          iconOnly && wideLabel && WIDE_BUTTON,
        )}
      >
        {isValidElement(Icon) ? Icon : <Icon />}
        {!iconOnly && label}
        {iconOnly && wideLabel && <span className={WIDE_LABEL}>{label}</span>}
      </Button>
    </Hint>
  )
}
