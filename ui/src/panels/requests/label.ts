/** What the panel of every pending request is called, and one or several of what it holds. */
export const REQUESTS = { label: 'Requests', one: 'request', many: 'requests' } as const

/** "1 request" or "3 requests". */
export const requestsText = (count: number) => `${String(count)} ${count === 1 ? REQUESTS.one : REQUESTS.many}`
