import type { ModAgentAccentProps, ModStatusMarkerProps } from '@seti/mod-api'
import { AGENT_COLOR_PRESETS } from '@seti/shared'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it } from 'vitest'
import { agentAccents, statusMarkers } from '@/lib/status-markers'
import { ModAgentAccent } from '@/panels/tasks/ModAgentAccent'
import { StatusLight } from '@/panels/tasks/StatusPill'

const color = AGENT_COLOR_PRESETS[0].hex
const agent = { id: 'a1', color }
const disposers: (() => void)[] = []

function Face({ status, agent: given, place }: ModAgentAccentProps) {
  return <i data-face={`${status} ${given.id} ${given.color ?? 'none'} ${place}`} />
}

function Marker({ place }: ModStatusMarkerProps) {
  return place === 'grid' ? <i data-marker="" /> : null
}

afterEach(() => {
  disposers.splice(0).forEach((dispose) => {
    dispose()
  })
})

describe('agent row accents', () => {
  it('draws nothing while no mod adds one, so the row keeps its bar', () => {
    expect(renderToStaticMarkup(<ModAgentAccent status="running" subagents={0} agent={agent} place="list" />)).toBe('')
  })

  it('hands the view the agent and gives it the marker tooltip, out of the accessibility tree', () => {
    disposers.push(agentAccents.register({ key: 'blobs.blobs', name: 'Blobs', view: Face }))
    const html = renderToStaticMarkup(<ModAgentAccent status="running" subagents={2} agent={agent} place="needsYou" />)
    expect(html).toContain('data-agent-accent=""')
    expect(html).toContain('aria-hidden="true"')
    expect(html).toContain('title="running: 2 subagents running"')
    expect(html).toContain(`data-agent-color="${color}"`)
    expect(html).toContain(`data-face="running a1 ${color} needsYou"`)
  })

  it('keeps the status marker it hides with the same role, name and tooltip', () => {
    const html = renderToStaticMarkup(<StatusLight status="blocked" place="list" subagents={1} agent={agent} />)
    expect(html).toContain('role="img"')
    expect(html).toContain('aria-label="waits on you"')
    expect(html).toContain('title="waits on you: 1 subagent running"')
    expect(html).toContain('data-status-light=""')
  })

  it('tells a status marker where it sits and keeps the Seti shape after it for places it skips', () => {
    disposers.push(statusMarkers.register({ key: 'blobs.blobs', name: 'Blobs', view: Marker }))
    const grid = renderToStaticMarkup(<StatusLight status="idle" place="grid" agent={agent} />)
    expect(grid).toMatch(
      /data-mod-marker="[^"]*"[^>]*><i data-marker=""><\/i><\/span><span class="contents" data-marker-fallback="">/,
    )
    const list = renderToStaticMarkup(<StatusLight status="idle" place="list" agent={agent} />)
    expect(list).toMatch(/data-mod-marker="[^"]*"[^>]*><\/span><span class="contents" data-marker-fallback=""><svg/)
  })
})
