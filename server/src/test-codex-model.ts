import fs from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import { ScriptedResponses, type ModelCall } from './runtimes/codex/conformance-responses.js'
import { codexCall } from './runtimes/codex/conformance-rig.js'
import type { ScriptCall, Step } from './runtimes/conformance/script.js'
import { loadSandboxCa } from './sandbox-ca.js'
import { MODEL_HOST, modelUpstream, type EgressNote } from './test-codex-upstream.js'

/** The model's call for a proof step; `add` creates a file with one line through `apply_patch`. */
function proofCall(call: ScriptCall): ModelCall {
  if (call.tool !== 'add') {
    return codexCall(call)
  }
  const { path: file, line } = call.args as { path: string; line: string }
  return { name: 'apply_patch', input: `*** Begin Patch\n*** Add File: ${file}\n+${line}\n*** End Patch\n` }
}

/**
 * OpenAI's API as a Codex agent's egress proxy reaches it in a test: HTTPS for `api.openai.com`
 * signed by a CA of the test's own, in front of the scripted Responses fake. It records every
 * host the proxy dials or refuses and the Authorization header of every model call.
 */
export class TestModelHost {
  readonly dialled: string[] = []
  readonly refused: string[] = []
  readonly authorizations: string[] = []
  readonly fake = new ScriptedResponses(proofCall)
  private front: https.Server | null = null
  /** The front's port and the file of the CA that signs it, once started. */
  port = 0
  caFile = ''

  /** Notes what a proxy did with a host, as a proxy in this process or a split node reports it. */
  readonly note: EgressNote = (kind, host) => {
    ;(kind === 'dialled' ? this.dialled : this.refused).push(host)
  }

  /** Starts the fake and its HTTPS front; resolves with what this process's proxies route through. */
  async start(dir: string): Promise<ReturnType<typeof modelUpstream>> {
    const base = new URL(await this.fake.start())
    const ca = await loadSandboxCa(path.join(dir, 'model-ca'))
    await ca.cover([MODEL_HOST])
    const context = await ca.contextFor(MODEL_HOST)
    const front = https.createServer(
      {
        SNICallback: (_name, done) => {
          done(null, context)
        },
      },
      (req, res) => {
        this.authorizations.push(req.headers.authorization ?? '')
        const out = http.request(
          { host: base.hostname, port: base.port, path: req.url, method: req.method, headers: req.headers },
          (answer) => {
            res.writeHead(answer.statusCode ?? 502, answer.headers)
            answer.pipe(res)
          },
        )
        req.pipe(out)
      },
    )
    await new Promise<void>((resolve) => front.listen(0, '127.0.0.1', resolve))
    this.front = front
    this.port = (front.address() as AddressInfo).port
    this.caFile = path.join(ca.publicDir, 'ca.pem')
    return modelUpstream(this.port, fs.readFileSync(this.caFile, 'utf8'), this.note)
  }

  play(turns: Step[][]): void {
    this.fake.play(turns)
  }

  /** Every model call's body as the fake received it, joined, to find what Codex told the model. */
  told(): string {
    return this.fake.bodies.join('\n')
  }

  close(): void {
    this.front?.closeAllConnections()
    this.front?.close()
    this.fake.close()
  }
}
