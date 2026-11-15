import { ArrowLeft } from 'lucide-react'
import { Hint } from '@/components/Hint'
import { DetailHeader } from '@/components/SplitPane'
import { Button } from '@/components/ui/button'
import { useRequests } from '@/hooks/useRequests'
import { goBack } from '@/lib/route'
import { RequestsView } from '@/panels/requests/RequestsView'
import { REQUESTS } from '@/panels/requests/label'

const back = () => {
  goBack('agents')
}

/** Every agent's pending requests in one place; it goes back once everything in it is settled. */
export function RequestsPage() {
  const { requests } = useRequests()
  return (
    <div className="flex h-full min-h-0 flex-col">
      <DetailHeader>
        <div className="flex items-center gap-2">
          <Hint text="Back to where you came from">
            <Button variant="ghost" size="icon-sm" className="-ml-2 shrink-0" aria-label="Back" onClick={back}>
              <ArrowLeft />
            </Button>
          </Hint>
          <h1 className="truncate text-lg font-semibold max-md:text-base">{REQUESTS.label}</h1>
        </div>
        <div className="text-xs text-muted-foreground">
          What your agents wait on you for: questions, access, plans and tool calls, then notes to approve.
        </div>
      </DetailHeader>
      <RequestsView requests={requests} submitLabel="Submit all" onEmpty={back} />
    </div>
  )
}
