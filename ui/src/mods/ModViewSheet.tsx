import { Package, X } from 'lucide-react'
import { ErrorBoundary } from '@/components/ErrorBoundary'
import { Hint } from '@/components/Hint'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet'
import { ModFrame } from './ModFrame'
import { agentTabs, showFrame, sidePanels, useOpenFrame, usePlacedFrames } from './frame-places'

/** The side sheet that shows a mod's agent tab or side panel; Seti's own dialogs stay above it. */
export function ModViewSheet() {
  const open = useOpenFrame()
  const tabs = usePlacedFrames(agentTabs)
  const panels = usePlacedFrames(sidePanels)
  const agentId = open?.agentId ?? null
  const placed = agentId === null ? panels : tabs
  const entry = open === null ? undefined : placed.find((view) => view.key === open.key)
  const key = `${entry?.key ?? ''}-${agentId ?? ''}`
  return (
    <Sheet
      open={entry !== undefined}
      onOpenChange={(next) => {
        if (!next) {
          showFrame(null)
        }
      }}
    >
      <SheetContent
        side="right"
        showCloseButton={false}
        className="gap-0 data-[side=right]:w-full data-[side=right]:sm:max-w-none data-[side=right]:md:w-[min(42rem,100vw)]"
      >
        {entry !== undefined && (
          <>
            <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-3">
              <SheetTitle className="truncate text-sm font-semibold">{entry.title}</SheetTitle>
              <SheetDescription className="sr-only">{`A view of the ${entry.modName} mod`}</SheetDescription>
              <Button
                variant="ghost"
                size="icon-sm"
                className="ml-auto"
                aria-label={`Close ${entry.title}`}
                onClick={() => {
                  showFrame(null)
                }}
              >
                <X />
              </Button>
            </div>
            <ErrorBoundary name={entry.title} resetKey={key}>
              <ModFrame
                key={key}
                modId={entry.modId}
                modName={entry.modName}
                kind="views"
                name={entry.view}
                title={entry.title}
                place={agentId === null ? 'sidePanel' : 'agentTab'}
                phone={entry.phone}
                {...(agentId === null ? {} : { agentId })}
              />
            </ErrorBoundary>
          </>
        )}
      </SheetContent>
    </Sheet>
  )
}

/** A button per mod view placed beside agents, which opens it with this agent as its context. */
export function AgentModTabs({ taskId }: { taskId: string }) {
  const tabs = usePlacedFrames(agentTabs)
  return tabs.map((tab) => (
    <Hint key={tab.key} text={`${tab.title}, a view of the ${tab.modName} mod`}>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={tab.title}
        onClick={() => {
          showFrame({ key: tab.key, agentId: taskId })
        }}
      >
        <Package />
      </Button>
    </Hint>
  ))
}
