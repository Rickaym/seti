import type { ModuleEntry } from '../../quickjs/engine.js'

/**
 * Runs before logic.js: takes away eval and every Function constructor, so mod code cannot
 * compile code from text and its pinned hash keeps describing what it does. The Eval intrinsic
 * stays, since the engine itself needs it to load the module.
 */
const LOCKDOWN = `(() => {
  const refuse = function () { throw new TypeError('Mods cannot compile code from text') }
  const lock = (proto) => {
    const stub = function () { return refuse() }
    Object.defineProperty(stub, 'prototype', { value: proto })
    Object.defineProperty(proto, 'constructor', { value: stub, writable: false, configurable: false })
    Object.freeze(stub)
    Object.freeze(proto)
    return stub
  }
  const protoOf = (fn) => Object.getPrototypeOf(fn)
  const generator = protoOf(function* () {})
  const asyncGenerator = protoOf(async function* () {})
  lock(protoOf(async function () {}))
  lock(generator)
  lock(asyncGenerator)
  const functionStub = lock(Function.prototype)
  Object.defineProperty(globalThis, 'Function', { value: functionStub, writable: false, configurable: false })
  delete globalThis.eval
})()`

/**
 * Builds the frozen seti object over the one host call, and calls the handler the event names.
 * A refused call throws an Error whose code says why: denied, invalid, limit, asked, failed or
 * busy.
 */
const PRELUDE = `(host, input, logic) => {
  const { event, ctx } = JSON.parse(input)
  const freeze = (value) => {
    if (value !== null && typeof value === 'object') {
      Object.values(value).forEach(freeze)
      Object.freeze(value)
    }
    return value
  }
  const call = async (op, args) => {
    const reply = JSON.parse(await host.call(JSON.stringify({ op, args })))
    if (reply.ok) return reply.value
    const error = new Error(reply.error.message)
    error.code = reply.error.code
    throw error
  }
  const text = (value) => (typeof value === 'string' ? value : JSON.stringify(value))
  const headers = (pairs) => {
    const map = new Map(pairs.map(([name, value]) => [String(name).toLowerCase(), value]))
    const key = (name) => String(name).toLowerCase()
    return Object.freeze({
      get: (name) => map.get(key(name)) ?? null,
      has: (name) => map.has(key(name)),
      entries: () => [...map.entries()],
    })
  }
  const fetch = async (url, init = {}) => {
    const { connection, method, headers: sent, body } = init
    const request = { url: String(url), method, headers: sent, body }
    const raw = connection === undefined
      ? await call('net.fetch', request)
      : await call('connection.fetch', { connection, ...request })
    return Object.freeze({
      status: raw.status,
      ok: raw.status >= 200 && raw.status < 300,
      url: raw.url,
      headers: headers(raw.headers),
      text: async () => raw.body,
      json: async () => JSON.parse(raw.body),
    })
  }
  const seti = freeze({
    settings: { get: () => call('settings.get', {}) },
    storage: {
      get: (key) => call('storage.get', { key }),
      keys: (prefix) => call('storage.keys', prefix === undefined ? {} : { prefix }),
      set: (key, value) => call('storage.set', { key, value }),
      delete: (key) => call('storage.delete', { key }),
    },
    log: (...values) => host.log(values.map(text).join(' ')),
    audit: (kind, summary, detail) => call('audit.record', { kind, summary, detail }),
    notify: (kind, { title, body, url } = {}) => call('notify.send', { kind, title, body, url }),
    fetch,
    tasks: {
      list: (options = {}) => call('tasks.list', options),
      get: (id) => call('tasks.get', { id }),
      transcript: (id, options = {}) => call('tasks.transcript', { id, ...options }),
      prs: (id) => call('tasks.prs', { id }),
      rename: (id, title) => call('tasks.manage.rename', { id, title }),
      pin: (id, on) => call('tasks.manage.pin', { id, on }),
      setColor: (id, color) => call('tasks.manage.set_color', { id, color }),
      linkPr: (id, url) => call('tasks.manage.link_pr', { id, url }),
      unlinkPr: (id, url) => call('tasks.manage.unlink_pr', { id, url }),
      start: ({ title, prompt, repo } = {}) => call('tasks.manage.start', { title, prompt, repo }),
      stop: (id) => call('tasks.manage.stop', { id }),
    },
    chat: {
      post: (message, { to } = {}) =>
        to === undefined ? call('chat.post', { text: message }) : call('chat.post.direct', { text: message, to }),
    },
    files: {
      list: (agentId, dir) => call('files.list', { agentId, dir }),
      read: (agentId, path) => call('files.read', { agentId, path }),
    },
    statusBar: { set: (item, { text: shown, icon } = {}) => call('status.set', { item, text: shown, icon }) },
  })
  const context = freeze(ctx)
  const own = (table, key) =>
    table !== null && typeof table === 'object' && Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined
  const handlerFor = () => {
    if (event.kind === 'command') return [own(own(logic, 'commands'), event.command), 'onCommand handler for ' + event.command, event.args]
    if (event.kind === 'webhook') {
      const { sourceId, headers: sent, body, receivedAt } = event
      return [own(own(logic, 'webhooks'), sourceId), 'onWebhook handler for ' + sourceId, { sourceId, headers: sent, body, receivedAt }]
    }
    if (event.kind === 'schedule') {
      const { scheduleId, since, now } = event
      return [own(own(logic, 'schedules'), scheduleId), 'onSchedule handler for ' + scheduleId, { scheduleId, since, now }]
    }
    const { type, taskId, at } = event
    return [own(logic, 'taskEvents'), 'onTaskEvent handler', { type, taskId, at }]
  }
  const [handler, name, payload] = handlerFor()
  if (typeof handler !== 'function') throw new Error('logic.js has no ' + name)
  return handler(freeze(payload), context, seti)
}`

/** How the logic host runs a mod's logic.js: lockdown first, then the module, then the handler. */
export const LOGIC_ENTRY: ModuleEntry = {
  file: 'logic.js',
  lockdown: LOCKDOWN,
  prelude: PRELUDE,
  main: { type: 'object', missing: 'logic.js has no default export; export default defineLogic({ ... })' },
}
