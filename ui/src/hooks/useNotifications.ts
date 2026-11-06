import { DEFAULT_TIERS, type NotificationStatus } from '@seti/shared'
import { useEffect } from 'react'
import { apiBeacon } from '@/api'
import { refreshAttentionSoon } from '@/hooks/useAttention'
import { usePolled } from '@/hooks/usePolled'
import { demoResetsAt } from '@/lib/demo'
import { deviceId } from '@/lib/device'
import { createPolledResource } from '@/lib/polled'

const statusResource = createPolledResource<NotificationStatus>('/notifications', 60_000)

/** A report every 20 s keeps the server's 45 s focus window open while the page stays visible. */
const FOCUS_REPORT_MS = 20_000

export const refreshNotifications = (): void => {
  statusResource.refresh()
}

/** The notification settings, the push key and devices; whether this device gets push. */
export function useNotifications() {
  const { data, error } = usePolled(statusResource)
  const id = deviceId()
  return {
    status: data,
    error,
    settings: data?.settings ?? DEFAULT_TIERS,
    subscribed: data?.devices.some((device) => device.device_id === id) ?? false,
  }
}

/**
 * Tells the server which agents this page shows while it is visible, and whether it has focus, so
 * pushes skip what the user sees here and the server knows when the user comes back. The public
 * demo has neither, so its pages do not report.
 */
export function useFocusReport(agents: readonly string[]): void {
  const key = agents.join(' ')
  useEffect(() => {
    if (demoResetsAt() !== null) {
      return undefined
    }
    const shown = key === '' ? [] : key.split(' ')
    const send = (visible: boolean) => {
      apiBeacon('/notifications/focus', {
        device_id: deviceId(),
        agents: visible ? shown : [],
        active: visible && document.hasFocus(),
      })
    }
    let wasVisible = document.visibilityState === 'visible'
    const report = () => {
      const visible = document.visibilityState === 'visible'
      send(visible)
      if (visible && !wasVisible) {
        refreshAttentionSoon()
      }
      wasVisible = visible
    }
    const leave = () => {
      send(false)
    }
    report()
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') {
        report()
      }
    }, FOCUS_REPORT_MS)
    document.addEventListener('visibilitychange', report)
    window.addEventListener('focus', report)
    window.addEventListener('blur', report)
    window.addEventListener('pagehide', leave)
    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', report)
      window.removeEventListener('focus', report)
      window.removeEventListener('blur', report)
      window.removeEventListener('pagehide', leave)
    }
  }, [key])
}
