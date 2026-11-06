const SUFFIX = '.settings'

/** A mod's page in Settings is `<mod>.settings`, so it never takes a name Seti's pages use. */
export const modSettingsKey = (id: string) => `${id}${SUFFIX}`

export const modOfSettingsKey = (key: string) => (key.endsWith(SUFFIX) ? key.slice(0, -SUFFIX.length) : key)
