import { describe, expect, it } from 'vitest'
import { LinkMonitor } from './link-monitor'

describe('LinkMonitor', () => {
  it('reports a drop once, and the rebuilt path once it connects', () => {
    const reports: boolean[] = []
    const link = new LinkMonitor((reconnecting) => reports.push(reconnecting))
    link.observe('connecting', 'checking')
    link.observe('connected', 'connected')
    link.observe('connected', 'disconnected')
    link.observe('disconnected', 'disconnected')
    link.rebuilding()
    link.observe('connecting', 'checking')
    link.observe('connected', 'connected')
    link.observe('connected', 'connected')
    expect(reports).toEqual([true, false])
  })

  it('counts a rebuild the transport starts on its own as a drop', () => {
    const reports: boolean[] = []
    const link = new LinkMonitor((reconnecting) => reports.push(reconnecting))
    link.rebuilding()
    link.observe(undefined, undefined)
    expect(reports).toEqual([true])
  })
})
