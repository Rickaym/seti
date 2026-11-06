import { useState } from 'react'
import { DEFAULT_FILTERS, type GraphFilters } from './graph-model'

const KEY = 'seti.home.filters'

function stored(): GraphFilters {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(KEY) ?? '{}')
    const saved = typeof raw === 'object' && raw !== null ? (raw as Partial<Record<keyof GraphFilters, unknown>>) : {}
    const pick = (key: keyof GraphFilters) => (typeof saved[key] === 'boolean' ? saved[key] : DEFAULT_FILTERS[key])
    return {
      repos: pick('repos'),
      tools: pick('tools'),
      subagents: pick('subagents'),
      archived: pick('archived'),
      cost: pick('cost'),
    }
  } catch {
    return DEFAULT_FILTERS
  }
}

/** The graph's filter toggles, remembered per browser. */
export function useGraphFilters(): [GraphFilters, (key: keyof GraphFilters, on: boolean) => void] {
  const [filters, setFilters] = useState(stored)
  const set = (key: keyof GraphFilters, on: boolean) => {
    setFilters((prev) => {
      const next = { ...prev, [key]: on }
      try {
        localStorage.setItem(KEY, JSON.stringify(next))
      } catch {
        // Storage can be blocked; the choice then lasts for this visit only.
      }
      return next
    })
  }
  return [filters, set]
}
