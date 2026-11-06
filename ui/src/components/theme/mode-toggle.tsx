import { Moon, Sun } from 'lucide-react'
import type { ComponentProps } from 'react'
import { Hint } from '@/components/Hint'
import { useTheme } from '@/components/theme/theme-context'
import { Button } from '@/components/ui/button'

export function ModeToggle({ side, className }: { side?: ComponentProps<typeof Hint>['side']; className?: string }) {
  const { mode, setMode } = useTheme()

  const toggle = () => {
    setMode(mode === 'dark' ? 'light' : 'dark')
  }

  return (
    <Hint text="Dark mode" side={side}>
      <Button
        variant="ghost"
        size="icon"
        aria-label="Dark mode"
        aria-pressed={mode === 'dark'}
        className={className}
        onClick={toggle}
      >
        <Sun className="h-[1.2rem] w-[1.2rem] scale-100 rotate-0 transition-all dark:scale-0 dark:-rotate-90" />
        <Moon className="absolute h-[1.2rem] w-[1.2rem] scale-0 rotate-90 transition-all dark:scale-100 dark:rotate-0" />
      </Button>
    </Hint>
  )
}
