import http from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Page, Request } from '@playwright/test'
import type { EaChatEvent, EaChatInput } from '@seti/shared'

interface Answer {
  sdp: string
  type: 'answer'
  pc_id: string
}

interface FakeBot {
  channel: RTCDataChannel | null
  closed: boolean
  /** Types of the RTVI client messages the page sent. */
  received: string[]
}

type FakeWindow = Window & { fakeEa?: FakeBot }

/** Answers an offer from a peer connection inside the page that speaks just enough RTVI. */
async function answerInPage(page: Page, offer: string): Promise<Answer> {
  return page.evaluate(async (sdp) => {
    const bot: FakeBot = { channel: null, closed: false, received: [] }
    ;(window as FakeWindow).fakeEa = bot
    const pc = new RTCPeerConnection()
    pc.ondatachannel = ({ channel }) => {
      bot.channel = channel
      channel.addEventListener('close', () => {
        bot.closed = true
      })
      channel.addEventListener('message', ({ data }) => {
        const text = String(data)
        if (!text.startsWith('{')) {
          return
        }
        const message = JSON.parse(text) as { id?: string; label?: string; type?: string; data?: { t?: string } }
        if (message.label === 'rtvi-ai' && message.type === 'client-message') {
          bot.received.push(message.data?.t ?? '')
        }
        if (message.label === 'rtvi-ai' && message.type === 'client-ready') {
          const ready = { label: 'rtvi-ai', type: 'bot-ready', id: message.id, data: { version: '2.2.0' } }
          channel.send(JSON.stringify(ready))
        }
      })
    }
    await pc.setRemoteDescription({ type: 'offer', sdp })
    const context = new AudioContext()
    const tone = context.createOscillator()
    const out = context.createMediaStreamDestination()
    tone.connect(out)
    tone.start()
    const [audio] = out.stream.getAudioTracks()
    const [transceiver] = pc.getTransceivers()
    if (audio !== undefined && transceiver !== undefined) {
      transceiver.direction = 'sendrecv'
      await transceiver.sender.replaceTrack(audio)
    }
    await pc.setLocalDescription(await pc.createAnswer())
    await new Promise<void>((resolve) => {
      if (pc.iceGatheringState === 'complete') {
        resolve()
        return
      }
      pc.addEventListener('icegatheringstatechange', () => {
        if (pc.iceGatheringState === 'complete') {
          resolve()
        }
      })
    })
    return { sdp: pc.localDescription?.sdp ?? '', type: 'answer' as const, pc_id: 'fake-ea' }
  }, offer)
}

/** Routes the EA offer to a fake bot in the page and records every offer the page posts. */
export async function fakeEa(page: Page): Promise<{ offers: Request[] }> {
  const offers: Request[] = []
  await page.route('**/api/ea/offer', async (route) => {
    const request = route.request()
    if (request.method() !== 'POST') {
      await route.fulfill({ json: { status: 'success' } })
      return
    }
    offers.push(request)
    const { sdp } = request.postDataJSON() as { sdp: string }
    try {
      await route.fulfill({ json: await answerInPage(page, sdp) })
    } catch (e) {
      if (!page.isClosed()) {
        throw e
      }
      await route.abort().catch(() => undefined)
    }
  })
  return { offers }
}

export async function botSays(page: Page, type: string, data?: unknown): Promise<void> {
  await page.evaluate(
    ([kind, payload]) => {
      ;(window as FakeWindow).fakeEa?.channel?.send(JSON.stringify({ label: 'rtvi-ai', type: kind, data: payload }))
    },
    [type, data] as const,
  )
}

export async function botClosed(page: Page): Promise<boolean> {
  return page.evaluate(() => (window as FakeWindow).fakeEa?.closed === true)
}

export async function botReceived(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as FakeWindow).fakeEa?.received ?? [])
}

/** One typed message the fake chat bot received, and the way to answer it. */
interface ChatTurn {
  text: string
  timezone: string | undefined
  send: (event: EaChatEvent) => void
  end: () => void
  /** Resolves when the page stops listening before the reply ends. */
  closed: Promise<void>
}

export interface FakeChat {
  /** The next message the page sends, once it arrives. */
  next: () => Promise<ChatTurn>
  close: () => Promise<void>
}

/** A chat bot on a local port behind the page's /api/ea/chat; each reply is up to the test. */
export async function fakeEaChat(page: Page): Promise<FakeChat> {
  const waiting: ((turn: ChatTurn) => void)[] = []
  const queued: ChatTurn[] = []
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as EaChatInput
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' })
      res.flushHeaders()
      let ended = false
      const turn: ChatTurn = {
        text: body.text,
        timezone: body.requestData?.timezone,
        send: (event) => {
          const { type, ...data } = event
          res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`)
        },
        end: () => {
          ended = true
          res.end()
        },
        closed: new Promise((resolve) => {
          res.on('close', () => {
            if (!ended) {
              resolve()
            }
          })
        }),
      }
      const taker = waiting.shift()
      if (taker === undefined) {
        queued.push(turn)
      } else {
        taker(turn)
      }
    })
  })
  const port = await new Promise<number>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve((server.address() as AddressInfo).port)
    })
  })
  await page.route('**/api/ea/chat', async (route) => route.continue({ url: `http://127.0.0.1:${String(port)}/chat` }))
  return {
    next: async () =>
      new Promise<ChatTurn>((resolve) => {
        const turn = queued.shift()
        if (turn === undefined) {
          waiting.push(resolve)
        } else {
          resolve(turn)
        }
      }),
    close: async () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => {
          resolve()
        })
      }),
  }
}
