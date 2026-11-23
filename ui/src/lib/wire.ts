/** A transcript read that asks for runtime rows as neutral events; an older server ignores it. */
export const asEvents = (path: string): string => `${path}${path.includes('?') ? '&' : '?'}wire=events`
