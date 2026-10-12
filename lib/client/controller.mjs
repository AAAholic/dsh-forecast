const API = '/api/dsh-forecast'
const requestId = () => globalThis.crypto?.randomUUID?.() ?? `next-${Date.now()}-${Math.random().toString(36).slice(2)}`

export function sessionEligible(session) {
  return Boolean(session && typeof session.sessionId === 'string' && session.sessionId
    && session.openState === 'open' && session.running !== true && session.blank !== true
    && session.removed !== true && session.subagent == null
    && (session.pendingSubmissions?.length ?? 0) === 0)
}

export function inputEmpty(input) {
  return Boolean(input && input.draft === '' && input.phase === 'plain'
    && Array.isArray(input.attachmentIds) && input.attachmentIds.length === 0
    && (input.occurrences?.length ?? 0) === 0)
}

function contextSignature(context) {
  const session = context?.session
  return JSON.stringify([context?.sessionId, context?.modeKey, sessionEligible(session),
    session?.openState, session?.running, session?.removed, session?.blank, session?.subagent != null,
    (session?.pendingSubmissions?.length ?? 0) > 0])
}

/** One generation per Host context key. Draft edits only hide the cached candidate. */
export class PredictionController {
  constructor({ settingsScope,
    fetcher = (...args) => globalThis.fetch(...args),
    schedule = (...args) => globalThis.setTimeout(...args),
    clear = (...args) => globalThis.clearTimeout(...args), autoConnect = true } = {}) {
    this.settingsScope = settingsScope
    this.fetcher = fetcher
    this.schedule = schedule
    this.clear = clear
    this.listeners = new Set()
    this.seen = new Set()
    this.acceptedTokens = new Set()
    this.suppressedKeys = new Set()
    this.generation = 0
    this.context = null
    this.signature = ''
    this.foreground = true
    this.disposed = false
    this.suspended = true
    this.enabled = false
    this.abort = new AbortController()
    this.timer = null
    this.flight = null
    this.prediction = null
    this.settleReads = 0
    this.state = Object.freeze({ key: null, status: 'idle', candidate: null })
    this.offSettings = null
    if (autoConnect) this.connect()
  }

  getSnapshot = () => this.state
  subscribe = listener => { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  emit() { for (const listener of this.listeners) listener() }
  publish(next) { this.state = Object.freeze(next); this.emit() }

  connect() {
    if (this.disposed || !this.suspended) return
    this.suspended = false
    this.offSettings = this.settingsScope?.subscribe(() => this.syncSettings())
    this.syncSettings()
    void this.read()
  }

  disconnect() {
    this.suspended = true
    this.invalidate()
    this.offSettings?.(); this.offSettings = null
  }

  syncSettings() {
    if (this.disposed) return
    const snapshot = this.settingsScope?.getSnapshot()
    const enabled = snapshot?.status === 'ready' && snapshot.value?.enabled !== false
    if (enabled === this.enabled) return
    this.enabled = enabled
    this.invalidate()
    if (enabled) void this.read()
  }

  updateContext(context) {
    if (this.disposed) return
    const signature = contextSignature(context)
    if (this.context?.sessionId === context?.sessionId && this.context?.modeKey !== context?.modeKey) {
      const key = this.state.key ?? this.prediction?.key
      if (key) this.suppressedKeys.add(`${context.sessionId}\u0000${key}`)
    }
    this.context = context
    if (signature === this.signature) return
    this.signature = signature
    this.invalidate()
    void this.read()
  }

  setForeground(foreground) {
    if (this.disposed || this.foreground === foreground) return
    this.foreground = foreground
    if (!foreground) { this.clear(this.timer); this.timer = null }
    else void this.read()
    this.emit()
  }

  current(generation) {
    return !this.disposed && !this.suspended && this.enabled && generation === this.generation
      && this.context?.sessionId === this.context?.session?.sessionId && sessionEligible(this.context?.session)
  }

  async remote(path, body, signal) {
    const response = await this.fetcher(`${API}/${path}`, body === undefined
      ? { credentials: 'same-origin', cache: 'no-store', signal }
      : { method: 'POST', credentials: 'same-origin', cache: 'no-store', signal,
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return response.json()
  }

  invalidate() {
    this.generation += 1
    this.clear(this.timer); this.timer = null
    this.abort.abort(); this.abort = new AbortController()
    this.flight = null
    const prediction = this.prediction
    this.prediction = null
    this.settleReads = 0
    if (prediction) void this.remote('cancel', prediction).catch(() => {})
    this.publish({ key: null, status: 'idle', candidate: null })
  }

  async read() {
    const generation = this.generation
    if (!this.foreground || !this.current(generation) || this.flight) return this.flight
    this.clear(this.timer); this.timer = null
    const sessionId = this.context.sessionId
    const signal = this.abort.signal
    const operation = Promise.resolve().then(async () => {
      try {
        const payload = await this.remote(`state?sessionId=${encodeURIComponent(sessionId)}`, undefined, signal)
        if (this.current(generation)) await this.receive(payload, generation)
      } catch {
        if (this.current(generation)) this.publish({ key: this.state.key, status: 'failed', candidate: null })
      } finally {
        if (generation === this.generation) this.flight = null
      }
    })
    this.flight = operation
    return operation
  }

  async receive(payload, generation) {
    if (!this.current(generation) || payload?.sessionId !== this.context.sessionId || payload.enabled !== true) return
    const key = typeof payload.key === 'string' && payload.key ? payload.key : null
    if (key && this.suppressedKeys.has(`${payload.sessionId}\u0000${key}`)) {
      this.publish({ key, status: 'empty', candidate: null })
      return
    }
    if (payload.status === 'ready' && key && typeof payload.token === 'string' && payload.token
      && typeof payload.suggestion === 'string' && payload.suggestion.trim()) {
      this.publish({ key, status: 'ready', candidate: Object.freeze({
        sessionId: payload.sessionId, key, token: payload.token, text: payload.suggestion.trim(), generation,
      }) })
      return
    }
    this.publish({ key, status: typeof payload.status === 'string' ? payload.status : 'empty', candidate: null })
    if (payload.status === 'pending') { this.poll(generation); return }
    // Running-status and durable-event transports can settle in either order.
    // Briefly reread only state; no completed context means no inference.
    if (!key && this.settleReads++ < 8) { this.poll(generation, 500); return }
    const seenKey = `${payload.sessionId}\u0000${key}`
    if (!key || payload.canGenerate !== true || this.seen.has(seenKey)) return
    this.seen.add(seenKey)
    const prediction = { sessionId: payload.sessionId, key, requestId: requestId() }
    this.prediction = prediction
    this.publish({ key, status: 'pending', candidate: null })
    try {
      const result = await this.remote('predict', prediction, this.abort.signal)
      if (this.current(generation)) await this.receive(result, generation)
    } catch {
      if (this.current(generation)) this.publish({ key, status: 'failed', candidate: null })
    }
  }

  poll(generation, delay = 1000) {
    this.clear(this.timer)
    if (!this.foreground || !this.current(generation)) return
    this.timer = this.schedule(() => { this.timer = null; void this.read() }, delay)
  }

  candidateCurrent(candidate = this.state.candidate) {
    return Boolean(candidate && this.current(candidate.generation)
      && candidate.sessionId === this.context?.sessionId && candidate.key === this.state.key)
  }

  accepted(candidate) {
    if (!this.candidateCurrent(candidate)) return
    if (this.acceptedTokens.has(candidate.token)) return
    this.acceptedTokens.add(candidate.token)
    void this.remote('accepted', { sessionId: candidate.sessionId, key: candidate.key, token: candidate.token }).catch(() => {})
  }

  dispose() {
    if (this.disposed) return
    this.disposed = true
    this.disconnect()
    this.listeners.clear()
  }
}
