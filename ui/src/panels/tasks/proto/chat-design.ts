/** Which chat prototype to show; only the `?chat=` URL parameter picks one, for comparing designs. */
export type ChatDesign = 'now' | 'a' | 'b' | 'c' | 'a-plus'

export function chatDesign(): ChatDesign {
  const value = new URLSearchParams(window.location.search).get('chat')
  return value === 'a' || value === 'b' || value === 'c' || value === 'a-plus' ? value : 'now'
}
