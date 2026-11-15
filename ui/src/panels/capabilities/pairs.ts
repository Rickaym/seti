export interface Pair {
  id: number
  key: string
  value: string
  /** What the value holds, from the connector the form started from. */
  hint: string
}

let nextPairId = 0
export const newPair = (key = '', value = '', hint = ''): Pair => {
  nextPairId += 1
  return { id: nextPairId, key, value, hint }
}
