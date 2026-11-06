import { hasTurn, loadIceServers } from './ice'

export type RelayResult =
  | { status: 'idle' }
  | { status: 'running' }
  | { status: 'ok'; ms: number; address: string | null }
  | { status: 'error'; message: string }
  | { status: 'skipped'; reason: string }

const TIMEOUT_MS = 15_000

/** The address of a relay candidate: `candidate:<f> <c> <proto> <prio> <ip> <port> typ relay`. */
function relayAddress(candidate: string): string | null {
  const [, , , , ip, port, typ, type] = candidate.split(' ')
  return typ === 'typ' && type === 'relay' && ip !== undefined && port !== undefined ? `${ip}:${port}` : null
}

function localDescription(pc: RTCPeerConnection): RTCSessionDescription {
  if (pc.localDescription === null) {
    throw new Error('The probe peer has no local description')
  }
  return pc.localDescription
}

type Finished = Extract<RelayResult, { status: 'ok' | 'error' }>

/** Candidates that arrive before the remote description would be dropped, so they wait. */
function candidateQueue(pc: RTCPeerConnection) {
  let ready = false
  const waiting: RTCIceCandidate[] = []
  const add = (candidate: RTCIceCandidate) => {
    pc.addIceCandidate(candidate).catch(() => undefined)
  }
  return {
    push: (candidate: RTCIceCandidate) => {
      if (ready) {
        add(candidate)
      } else {
        waiting.push(candidate)
      }
    },
    open: () => {
      ready = true
      waiting.splice(0).forEach(add)
    },
  }
}

/** The caller may only use the relay, proving TURN auth; the callee spares the relay a hairpin. */
async function connectThroughRelay(iceServers: RTCIceServer[]): Promise<Finished> {
  const caller = new RTCPeerConnection({ iceServers, iceTransportPolicy: 'relay' })
  const callee = new RTCPeerConnection({ iceServers, iceTransportPolicy: 'all' })
  const toCaller = candidateQueue(caller)
  const toCallee = candidateQueue(callee)
  const start = performance.now()
  let address: string | null = null

  return new Promise<Finished>((resolve) => {
    const finish = (result: Finished) => {
      clearTimeout(timer)
      caller.close()
      callee.close()
      resolve(result)
    }
    const timer = setTimeout(() => {
      finish({ status: 'error', message: `No relay connection within ${String(TIMEOUT_MS / 1000)} s` })
    }, TIMEOUT_MS)

    caller.onicecandidate = (e) => {
      if (e.candidate === null) {
        return
      }
      address ??= relayAddress(e.candidate.candidate)
      toCallee.push(e.candidate)
    }
    callee.onicecandidate = (e) => {
      if (e.candidate !== null) {
        toCaller.push(e.candidate)
      }
    }
    callee.onconnectionstatechange = () => {
      if (callee.connectionState === 'connected') {
        finish({ status: 'ok', ms: Math.round(performance.now() - start), address })
      } else if (callee.connectionState === 'failed') {
        finish({ status: 'error', message: 'The relay refused the connection. Its credentials may be invalid.' })
      }
    }

    caller.createDataChannel('probe')
    const exchange = async () => {
      await caller.setLocalDescription(await caller.createOffer())
      await callee.setRemoteDescription(localDescription(caller))
      toCallee.open()
      await callee.setLocalDescription(await callee.createAnswer())
      await caller.setRemoteDescription(localDescription(callee))
      toCaller.open()
    }
    exchange().catch((e: unknown) => {
      finish({ status: 'error', message: e instanceof Error ? e.message : 'SDP exchange failed' })
    })
  })
}

/** Checks that the TURN relay the bot hands out works from this browser. */
export async function testRelay(): Promise<Exclude<RelayResult, { status: 'idle' | 'running' }>> {
  let iceServers: RTCIceServer[]
  try {
    iceServers = await loadIceServers()
  } catch (e) {
    return { status: 'error', message: e instanceof Error ? e.message : String(e) }
  }
  if (!hasTurn(iceServers)) {
    return { status: 'skipped', reason: 'The bot hands out no TURN relay' }
  }
  return connectThroughRelay(iceServers)
}
