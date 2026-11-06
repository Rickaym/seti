import type { ModKit } from '@seti/mod-api'
import { toast } from 'sonner'
import { errorText } from '@/api'
import { CopyButton } from '@/components/CopyButton'
import { Hint } from '@/components/Hint'
import { Markdown } from '@/components/Markdown'
import { NewsDot } from '@/components/NewsDot'
import { ToggleButton } from '@/components/ToggleButton'
import { ItemHint, StatusBarItem } from '@/components/status-bar/StatusBarItem'
import { Button } from '@/components/ui/button'
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import { ViewerActionsSlot } from '@/panels/files/ViewerActionsSlot'
import { fetchRaw } from '@/panels/files/files-api'
import { AgentText } from '@/panels/tasks/Transcript'
import { Line } from '@/panels/tasks/TranscriptLines'
import { Tag } from '@/panels/tasks/pr-badges'
import { KitDialog } from './KitDialog'

/** The controls bundled mods draw their views with, so they match the rest of Seti. */
export const MOD_KIT: ModKit = {
  Button,
  Input,
  Textarea,
  Hint,
  ToggleButton,
  CopyButton,
  Markdown,
  Tag,
  AgentText,
  Line,
  NewsDot,
  fail: (title, description) => {
    toast.error(title, { description, duration: Infinity })
  },
  succeed: (title) => {
    toast.success(title)
  },
  ViewerActions: ViewerActionsSlot,
  fetchRaw,
  errorText,
  cn,
  Dialog: KitDialog,
  StatusItem: StatusBarItem,
  StatusHint: ItemHint,
  DropdownMenu: {
    Root: DropdownMenu,
    Trigger: DropdownMenuTrigger,
    Content: DropdownMenuContent,
    Item: DropdownMenuItem,
    Separator: DropdownMenuSeparator,
    RadioGroup: DropdownMenuRadioGroup,
    RadioItem: DropdownMenuRadioItem,
  },
  Command: { Root: Command, Input: CommandInput, List: CommandList, Item: CommandItem, Empty: CommandEmpty },
  toast: (message, options) => {
    toast(message, options)
  },
}
