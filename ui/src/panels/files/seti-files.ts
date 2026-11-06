const KEY = 'seti.files.seti-files'

/** Whether this browser shows the files Seti writes into the workspace; hidden until turned on. */
export function storedShowSetiFiles(): boolean {
  try {
    return localStorage.getItem(KEY) === 'on'
  } catch {
    return false
  }
}

export function storeShowSetiFiles(show: boolean): void {
  try {
    localStorage.setItem(KEY, show ? 'on' : 'off')
  } catch {
    // Storage can be blocked; the choice then lasts for this visit only.
  }
}
