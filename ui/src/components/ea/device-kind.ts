import type { EaInputKind } from '@seti/shared'

const BLUETOOTH = /bluetooth|\bbt\b|airpods|buds|hands-?free|\ble audio\b/i
const BUILT_IN = /speakerphone|earpiece|built-?in|internal|microphone array/i
const USB = /\busb\b/i
const WIRED = /wired|headphone|headset|line in|external/i

/** Whether a device name is a Bluetooth one's; Chrome on Android says "Bluetooth headset". */
export const isBluetooth = (label: string): boolean => BLUETOOTH.test(label)

/**
 * The kind of microphone a track opened, from its name; `pinned` says a device was asked for.
 * The phone's own "Headset earpiece" counts as built-in, so that test runs before the wired one.
 */
export function inputKind(label: string, pinned: boolean): EaInputKind {
  if (isBluetooth(label)) {
    return 'bluetooth'
  }
  if (BUILT_IN.test(label)) {
    return 'built-in'
  }
  if (USB.test(label)) {
    return 'usb'
  }
  if (WIRED.test(label)) {
    return 'wired'
  }
  return pinned ? 'other' : 'default'
}
