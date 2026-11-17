import { CONNECTION_TEMPLATES, SERVICE_ICON_KEYS } from '@seti/shared'
import { Plug } from 'lucide-react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ServiceIcon } from './ServiceIcon'
import { serviceMark } from './service-marks'

describe('service marks', () => {
  it('has a path for every icon key a catalog may name', () => {
    for (const key of SERVICE_ICON_KEYS) {
      expect(serviceMark(key), key).toMatch(/^M[\d\s.,a-zA-Z-]+$/)
    }
  })

  it('resolves the icon of every connection template that names one', () => {
    const named = CONNECTION_TEMPLATES.filter((template) => template.icon !== null)
    expect(named.length).toBeGreaterThan(10)
    for (const template of named) {
      expect(serviceMark(template.icon), template.id).toBeDefined()
    }
  })

  it('knows no mark for a missing or unknown key', () => {
    expect(serviceMark(null)).toBeUndefined()
    expect(serviceMark(undefined)).toBeUndefined()
    expect(serviceMark('no-such-service')).toBeUndefined()
    expect(serviceMark('constructor')).toBeUndefined()
  })
})

describe('ServiceIcon', () => {
  it('draws the mark in the text colour, hidden from assistive technology', () => {
    const html = renderToStaticMarkup(<ServiceIcon icon="stripe" fallback={Plug} />)
    expect(html).toContain('data-service-icon="stripe"')
    expect(html).toContain('fill="currentColor"')
    expect(html).toContain('aria-hidden="true"')
    expect(html).not.toContain('lucide')
  })

  it('falls back to the lucide icon for an unknown key', () => {
    const html = renderToStaticMarkup(<ServiceIcon icon="no-such-service" fallback={Plug} />)
    expect(html).toContain('lucide-plug')
    expect(html).toContain('aria-hidden="true"')
    expect(html).not.toContain('data-service-icon')
  })
})
