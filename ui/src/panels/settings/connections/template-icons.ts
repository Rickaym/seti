import type { TemplateCategory } from '@seti/shared'
import {
  Activity,
  Cloud,
  Code,
  CreditCard,
  ListChecks,
  Mail,
  MessageSquare,
  Mic,
  Sparkles,
  type LucideIcon,
} from 'lucide-react'

/** One icon per kind of service; templates carry no brand logos. */
export const TEMPLATE_ICON: Record<TemplateCategory, LucideIcon> = {
  cloud: Cloud,
  ai: Sparkles,
  voice: Mic,
  payments: CreditCard,
  messaging: MessageSquare,
  email: Mail,
  developer: Code,
  monitoring: Activity,
  work: ListChecks,
}
