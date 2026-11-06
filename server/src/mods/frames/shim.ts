/**
 * The first script of every mod page. It makes the page's script, link and frame sinks refuse,
 * since a hash-pinned policy still lets a script or preload whose integrity matches a pinned hash
 * load from anywhere. It keeps storage in memory, removes WebRTC, asks Seti's
 * page for the bridge port with the frame's nonce until it arrives, and gives the page
 * `window.seti`. It runs before the mod's own scripts, so they find the globals already gone.
 */
export const VIEW_SHIM = `(function () {
  'use strict'
  var w = window
  var refuse = function () { throw new TypeError('A mod view loads no scripts, links or frames') }
  var TAGS = /<\\s*(script|link|meta|base|iframe|frame|frameset|object|embed|portal)\\b/i
  var BANNED = /^(?:[^:]*:)?(script|link|meta|base|iframe|frame|frameset|object|embed|portal)$/i
  w.trustedTypes.createPolicy('default', {
    createHTML: function (html) { if (TAGS.test(html)) { refuse() } return html },
    createScript: refuse,
    createScriptURL: refuse
  })
  var doc = Document.prototype
  var createElement = doc.createElement
  var createElementNS = doc.createElementNS
  Object.defineProperty(doc, 'createElement', { writable: false, configurable: false, value: function (name) {
    if (BANNED.test(String(name))) { refuse() }
    return createElement.apply(this, arguments)
  } })
  Object.defineProperty(doc, 'createElementNS', { writable: false, configurable: false, value: function (ns, name) {
    if (BANNED.test(String(name))) { refuse() }
    return createElementNS.apply(this, arguments)
  } })
  function memory() {
    var data = new Map()
    return {
      getItem: function (k) { k = String(k); return data.has(k) ? data.get(k) : null },
      setItem: function (k, v) { data.set(String(k), String(v)) },
      removeItem: function (k) { data.delete(String(k)) },
      clear: function () { data.clear() },
      key: function (i) { var keys = Array.from(data.keys()); i = Number(i); return i >= 0 && i < keys.length ? keys[i] : null },
      get length() { return data.size }
    }
  }
  ['localStorage', 'sessionStorage'].forEach(function (name) {
    try { void w[name].length } catch (e) {
      Object.defineProperty(w, name, { value: memory(), configurable: false })
    }
  });
  ['RTCPeerConnection', 'webkitRTCPeerConnection', 'mozRTCPeerConnection', 'RTCDataChannel',
   'RTCSessionDescription', 'RTCIceCandidate', 'RTCRtpSender', 'RTCRtpReceiver', 'RTCRtpTransceiver',
   'RTCDtlsTransport', 'RTCIceTransport', 'RTCSctpTransport', 'RTCCertificate'].forEach(function (name) {
    try { Object.defineProperty(w, name, { value: undefined, writable: false, configurable: false }) } catch (e) {}
  });
  var found = /(?:^#|&)n=([0-9a-f-]{36})(?:&|$)/.exec(location.hash)
  var nonce = found ? found[1] : ''
  var port = null
  var queue = []
  var nextId = 1
  var pending = new Map()
  var listeners = {}
  var last = {}
  function emit(type, data) {
    last[type] = data;
    (listeners[type] || []).slice().forEach(function (fn) {
      try { fn(data) } catch (e) { console.error(e) }
    })
  }
  function send(message) {
    if (port) { port.postMessage(message) } else { queue.push(message) }
  }
  function call(op, extra) {
    return new Promise(function (resolve, reject) {
      var id = nextId++
      pending.set(id, { resolve: resolve, reject: reject })
      send(Object.assign({ t: 'call', id: id, op: op }, extra))
    })
  }
  function applyTheme(theme) {
    var root = document.documentElement
    Object.keys(theme.vars).forEach(function (name) { root.style.setProperty(name, theme.vars[name]) })
    root.style.setProperty('--font-sans', theme.font.sans)
    root.style.setProperty('--font-mono', theme.font.mono)
    root.style.colorScheme = theme.scheme
  }
  function receive(event) {
    var m = event.data
    if (!m || typeof m !== 'object') { return }
    if (m.t === 'result') {
      var waiting = pending.get(m.id)
      if (!waiting) { return }
      pending.delete(m.id)
      if (m.ok) { waiting.resolve(m.value); return }
      var error = new Error(m.error && m.error.message ? m.error.message : 'The call failed')
      error.code = m.error ? m.error.code : 'failed'
      waiting.reject(error)
      return
    }
    if (m.t === 'theme') { applyTheme(m) }
    emit(m.t, m)
  }
  w.addEventListener('message', function (event) {
    var d = event.data
    if (port !== null || event.source !== w.parent || !d || d.seti !== 'mod-port') { return }
    if (d.v !== 1 || d.nonce !== nonce || !event.ports || event.ports.length !== 1) { return }
    event.stopImmediatePropagation()
    port = event.ports[0]
    port.onmessage = receive
    queue.splice(0).forEach(function (message) { port.postMessage(message) })
  }, true)
  function on(type, fn) {
    if (typeof fn !== 'function') { throw new TypeError('seti.on takes a function') }
    (listeners[type] = listeners[type] || []).push(fn)
    if (last[type] !== undefined) { fn(last[type]) }
    return function () {
      var list = listeners[type] || []
      var at = list.indexOf(fn)
      if (at >= 0) { list.splice(at, 1) }
    }
  }
  var api = Object.freeze({
    version: 1,
    ready: function () { send({ t: 'ready' }) },
    run: function (command, args) { return call('command', { command: String(command), args: args || {} }) },
    storage: Object.freeze({
      get: function (key) { return call('storage.get', { key: String(key) }) },
      keys: function (prefix) { return call('storage.keys', prefix === undefined ? {} : { prefix: String(prefix) }) },
      set: function (key, value) { return call('storage.set', { key: String(key), value: value }) },
      delete: function (key) { return call('storage.delete', { key: String(key) }) }
    }),
    settings: Object.freeze({ get: function () { return call('settings.get', {}) } }),
    on: on,
    resize: function (height) { send({ t: 'resize', height: Math.round(Number(height)) }) },
    open: function (route) { send({ t: 'open', to: String(route) }) },
    link: function (url) { send({ t: 'link', url: String(url) }) }
  })
  Object.defineProperty(w, 'seti', { value: api, writable: false, configurable: false })
  var tries = 0
  function hello() {
    if (port !== null || tries++ >= 50) { return }
    w.parent.postMessage({ seti: 'mod-hello', v: 1, nonce: nonce }, '*')
    setTimeout(hello, 100)
  }
  hello()
})()`
