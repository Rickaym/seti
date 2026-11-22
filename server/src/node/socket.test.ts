import { describe, expect, it } from 'vitest'
import { checkNodeSocket } from './socket.js'

const SOCKET = '/seti/run/node.sock'
const ME = 1000

const stats = (dir: { uid: number; mode: number }, file: { uid: number; mode: number }) => (at: string) =>
  at === SOCKET ? file : dir

describe('node socket check', () => {
  it('takes a socket of this user in a folder only it can enter', () => {
    expect(() => {
      checkNodeSocket(SOCKET, ME, stats({ uid: ME, mode: 0o40700 }, { uid: ME, mode: 0o140600 }))
    }).not.toThrow()
  })

  it('refuses a socket another user made', () => {
    expect(() => {
      checkNodeSocket(SOCKET, ME, stats({ uid: ME, mode: 0o40700 }, { uid: 1001, mode: 0o140600 }))
    }).toThrow(/another user/)
  })

  it('refuses a folder or socket other users can reach', () => {
    expect(() => {
      checkNodeSocket(SOCKET, ME, stats({ uid: ME, mode: 0o40755 }, { uid: ME, mode: 0o140600 }))
    }).toThrow(/this user alone/)
    expect(() => {
      checkNodeSocket(SOCKET, ME, stats({ uid: 1001, mode: 0o40700 }, { uid: ME, mode: 0o140600 }))
    }).toThrow(/this user alone/)
    expect(() => {
      checkNodeSocket(SOCKET, ME, stats({ uid: ME, mode: 0o40700 }, { uid: ME, mode: 0o140666 }))
    }).toThrow(/Other users/)
  })
})
