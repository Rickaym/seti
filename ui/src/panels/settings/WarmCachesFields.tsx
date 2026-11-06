import type { WarmCacheStatus } from '@seti/shared'
import { Flame, RotateCcw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import type { WarmCacheForm } from './warm-cache-form'

/** The warm cache part of a repo's settings: on or off, which caches, and the size cap. */
export function WarmCachesFields({
  status,
  form,
  onChange,
}: {
  status: WarmCacheStatus
  form: WarmCacheForm
  onChange: (next: WarmCacheForm) => void
}) {
  return (
    <section aria-label="Warm caches" className="col-span-full space-y-3 rounded-md border border-border p-3">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0 space-y-0.5">
          <h3 className="flex items-center gap-1.5 text-sm font-medium">
            <Flame className="size-4 text-muted-foreground" />
            Warm caches
          </h3>
          <p className="text-2xs text-muted-foreground">
            New worktrees get gitignored build caches from the main checkout, or from another agent&apos;s worktree when
            its caches are newer, so the first typecheck or build starts warm.
          </p>
        </div>
        <Switch
          aria-label="Warm caches"
          checked={form.enabled}
          onCheckedChange={(enabled) => {
            onChange({ ...form, enabled })
          }}
        />
      </div>
      {status.hint !== null && (
        <p role="note" className="text-2xs text-warning-text">
          {status.hint}
        </p>
      )}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium">Cache patterns</span>
          <Button
            variant="ghost"
            size="xs"
            onClick={() => {
              onChange({ ...form, patterns: status.defaults.patterns.join('\n') })
            }}
          >
            <RotateCcw />
            Defaults
          </Button>
        </div>
        <Textarea
          aria-label="Cache patterns"
          className="max-h-60 font-mono"
          rows={6}
          disabled={!form.enabled}
          value={form.patterns}
          onChange={(e) => {
            onChange({ ...form, patterns: e.target.value })
          }}
        />
        <p className="text-2xs text-muted-foreground">
          One glob per line; ** spans folders, a name alone matches at any depth. Only gitignored, untracked paths are
          copied; never .env files, .git or links leading out of the checkout.
        </p>
      </div>
      <div className="flex items-center gap-2 text-xs">
        <span className="font-medium">Size cap</span>
        <Input
          aria-label="Size cap"
          className="w-28"
          inputMode="numeric"
          disabled={!form.enabled}
          value={form.max_mb}
          onChange={(e) => {
            onChange({ ...form, max_mb: e.target.value })
          }}
        />
        <span className="text-muted-foreground">MB per worktree</span>
      </div>
    </section>
  )
}
