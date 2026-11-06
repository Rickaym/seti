import { homeSummarySchema, type HomeSummary } from '@seti/shared'
import { usePolled } from '@/hooks/usePolled'
import { createPolledResource } from '@/lib/polled'

const ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone

/** Seti counts the 30 days that end today in the reader's zone, so they roll over at midnight. */
const home = createPolledResource(`/home?zone=${encodeURIComponent(ZONE)}`, 5000, { schema: homeSummarySchema })

/** The Home page's counts and the calls running now, polled while shown. */
export function useHome(): { summary: HomeSummary | null; error: string | null } {
  const { data, error } = usePolled(home)
  return { summary: data ?? null, error }
}
