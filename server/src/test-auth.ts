import { credential, type CredentialName } from './credentials.js'

function bearer(name: CredentialName): { authorization: string } {
  const token = credential(name)
  if (token === null) {
    throw new Error(`Tests need the ${name} credential`)
  }
  return { authorization: `Bearer ${token}` }
}

/** The headers a local request needs to reach the API as the user. */
export const USER_AUTH = bearer('local-token-user')

/** The headers the EA voice bot sends with its token. */
export const EA_AUTH = { ...bearer('local-token-ea'), 'x-seti-via': 'ea' }
