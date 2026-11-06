import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto'
import { isoCBOR } from '@simplewebauthn/server/helpers'

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url')
const sha256 = (data: Uint8Array | string) => createHash('sha256').update(data).digest()

/** User present and user verified, plus attested credential data when a key is new. */
const FLAGS = { up: 0x01, uv: 0x04, at: 0x40 }

/** A software P-256 passkey that answers like a platform authenticator with `none` attestation. */
export class SoftAuthenticator {
  private readonly keys = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  readonly credentialId = randomBytes(16)
  private counter = 0

  readonly origin: string
  readonly rpId: string

  constructor(origin: string, rpId: string) {
    this.origin = origin
    this.rpId = rpId
  }

  get id(): string {
    return b64(this.credentialId)
  }

  private cosePublicKey(): Uint8Array {
    const jwk = this.keys.publicKey.export({ format: 'jwk' })
    return isoCBOR.encode(
      new Map<number, number | Uint8Array>([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, Buffer.from(jwk.x ?? '', 'base64url')],
        [-3, Buffer.from(jwk.y ?? '', 'base64url')],
      ]),
    )
  }

  private authData(attested: boolean, rpId: string): Buffer {
    const counter = Buffer.alloc(4)
    counter.writeUInt32BE(this.counter)
    const flags = Buffer.from([FLAGS.up | FLAGS.uv | (attested ? FLAGS.at : 0)])
    const parts = [sha256(rpId), flags, counter]
    if (attested) {
      const length = Buffer.alloc(2)
      length.writeUInt16BE(this.credentialId.length)
      parts.push(Buffer.alloc(16), length, this.credentialId, Buffer.from(this.cosePublicKey()))
    }
    return Buffer.concat(parts)
  }

  private clientData(type: string, challenge: string, origin: string): Buffer {
    return Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }))
  }

  register(challenge: string, origin = this.origin, rpId = this.rpId) {
    const attestationObject = isoCBOR.encode(
      new Map<string, string | Uint8Array | Map<string, string>>([
        ['fmt', 'none'],
        ['attStmt', new Map<string, string>()],
        ['authData', this.authData(true, rpId)],
      ]),
    )
    return {
      id: this.id,
      rawId: this.id,
      type: 'public-key' as const,
      response: {
        clientDataJSON: b64(this.clientData('webauthn.create', challenge, origin)),
        attestationObject: b64(attestationObject),
        transports: ['internal' as const],
      },
    }
  }

  assert(challenge: string, origin = this.origin, rpId = this.rpId) {
    this.counter += 1
    const authenticatorData = this.authData(false, rpId)
    const clientDataJSON = this.clientData('webauthn.get', challenge, origin)
    const signature = sign('sha256', Buffer.concat([authenticatorData, sha256(clientDataJSON)]), this.keys.privateKey)
    return {
      id: this.id,
      rawId: this.id,
      type: 'public-key' as const,
      response: {
        clientDataJSON: b64(clientDataJSON),
        authenticatorData: b64(authenticatorData),
        signature: b64(signature),
      },
    }
  }
}
