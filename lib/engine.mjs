import { readFile, mkdir, open, rename, unlink, chmod } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { acquireLedgerLease, syncDirectory } from './ownership.mjs'

const STATUSES = new Set(['pending', 'ready', 'empty', 'failed', 'cancelled'])
const MAX_SESSIONS = 4096
const MAX_AUDITS = 80
const MAX_LEDGER_BYTES = 4 * 1024 * 1024

export class EngineError extends Error {
  constructor(code, status = 400) { super(code); this.code = code; this.status = status }
}

/** One private durable reservation per true completed turn; inference is never retried. */
export class PredictionEngine {
  constructor({ ledgerPath, getContext, buildPrompt, normalizeSuggestion, infer, enabled = () => true,
    timeoutMs = 20_000, maxConcurrent = 2, ownerWaitMs = 2000, now = Date.now, uuid = randomUUID } = {}) {
    Object.assign(this, { ledgerPath, getContext, buildPrompt, normalizeSuggestion, infer, enabled,
      timeoutMs, maxConcurrent, ownerWaitMs, now, uuid })
    this.ledger = { version: 1, sessions: {}, audits: [] }
    this.active = new Map()
    this.flights = new Set()
    this.tail = Promise.resolve()
    this.closed = false
    this.persistenceError = null
    this.ownerToken = this.uuid()
    this.ownerPath = `${ledgerPath}.owner`
    this.ownsLedger = false
    this.loaded = this.load()
  }

  async load() {
    // Take the writer lock before reading: a departing owner may have reserved
    // a turn after this process started. Never spend against a stale ledger.
    try { await this.acquireOwner() } catch {
      this.persistenceError = 'ledger-owned-or-unavailable'
      return
    }
    try {
      const source = await readFile(this.ledgerPath, 'utf8')
      if (Buffer.byteLength(source) > MAX_LEDGER_BYTES) throw new Error('ledger too large')
      const value = JSON.parse(source)
      if (value?.version !== 1 || !value.sessions || typeof value.sessions !== 'object'
        || Array.isArray(value.sessions) || !Array.isArray(value.audits)) throw new Error('invalid ledger')
      for (const [id, row] of Object.entries(value.sessions)) {
        if (!validId(id) || !Number.isSafeInteger(row?.highWater) || row.highWater < 0
          || typeof row.key !== 'string' || !STATUSES.has(row.status)
          || typeof row.requestId !== 'string' || !validId(row.requestId)) throw new Error('invalid row')
        if (row.status === 'ready' && (typeof row.suggestion !== 'string' || !row.suggestion
          || typeof row.token !== 'string' || !row.token)) throw new Error('invalid candidate')
        // A lost process never resumes or retries a reserved provider call.
        if (row.status === 'pending') { row.status = 'failed'; row.error = 'interrupted' }
      }
      if (Object.keys(value.sessions).length > MAX_SESSIONS) throw new Error('too many sessions')
      this.ledger = value
    } catch (error) {
      if (error?.code !== 'ENOENT') this.persistenceError = 'ledger-unavailable'
    }
  }

  async acquireOwner() {
    this.lease = await acquireLedgerLease(this.ledgerPath, this.ownerToken, {
      waitMs: this.ownerWaitMs,
      onError: () => { this.persistenceError = 'ledger-owner-lost'; this.disable() },
    })
    this.ownsLedger = true
  }

  enqueue(work) {
    const next = this.tail.then(work)
    this.tail = next.catch(() => {})
    return next
  }

  context(sessionId) {
    if (!validId(sessionId)) throw new EngineError('invalid-session')
    try {
      const value = this.getContext(sessionId)
      if (!value || typeof value.key !== 'string' || !value.key || value.key.length > 512
        || !Number.isSafeInteger(value.turnSeq) || value.turnSeq < 0
        || typeof value.route?.provider !== 'string' || typeof value.route?.model !== 'string') return null
      return { ...value, sessionId }
    } catch { return null }
  }

  isEnabled() {
    try { return !this.closed && this.enabled() === true } catch { return false }
  }

  state(sessionId) {
    const context = this.context(sessionId)
    const enabled = this.isEnabled()
    const row = this.ledger.sessions[sessionId]
    const current = context && row?.key === context.key && row.highWater === context.turnSeq
    return {
      enabled, sessionId, key: context?.key ?? null,
      status: current ? row.status : 'idle',
      token: current && row.status === 'ready' ? row.token : null,
      suggestion: enabled && current && row.status === 'ready' ? row.suggestion : null,
      canGenerate: Boolean(enabled && !this.persistenceError && context
        && (!row || context.turnSeq > row.highWater)),
    }
  }

  async getState(sessionId) { await this.loaded; return this.state(sessionId) }

  async persist() {
    if (!this.ownsLedger || !this.lease?.active) throw new Error('ledger owner unavailable')
    const text = JSON.stringify(this.ledger)
    if (Buffer.byteLength(text) > MAX_LEDGER_BYTES) throw new Error('ledger size limit')
    await mkdir(dirname(this.ledgerPath), { recursive: true, mode: 0o700 })
    await chmod(dirname(this.ledgerPath), 0o700)
    const temporary = `${this.ledgerPath}.${this.uuid()}.tmp`
    let handle
    try {
      handle = await open(temporary, 'wx', 0o600)
      await handle.writeFile(text, 'utf8')
      await handle.sync()
      await handle.close(); handle = null
      await rename(temporary, this.ledgerPath)
      await chmod(this.ledgerPath, 0o600)
      await syncDirectory(dirname(this.ledgerPath))
    } finally {
      await handle?.close().catch(() => {})
      await unlink(temporary).catch(() => {})
    }
  }

  async predict({ sessionId, key, requestId }, requestSignal) {
    await this.loaded
    return this.enqueue(async () => {
      if (!validId(requestId) || typeof key !== 'string' || !key || key.length > 512)
        throw new EngineError('invalid-request')
      if (!this.isEnabled()) return this.state(sessionId)
      if (this.persistenceError) throw new EngineError(this.persistenceError, 503)
      const context = this.context(sessionId)
      if (!context || context.key !== key) throw new EngineError('stale-context', 409)
      const previous = this.ledger.sessions[sessionId]
      if (previous && context.turnSeq <= previous.highWater) return this.state(sessionId)
      if (this.active.size >= this.maxConcurrent) throw new EngineError('busy', 429)
      if (!previous && Object.keys(this.ledger.sessions).length >= MAX_SESSIONS)
        throw new EngineError('ledger-capacity', 503)
      if (requestSignal?.aborted) throw new EngineError('request-cancelled', 409)
      const prompt = this.buildPrompt(context)
      if (typeof prompt?.system !== 'string' || typeof prompt?.input !== 'string'
        || Buffer.byteLength(prompt.system + prompt.input, 'utf8') > 32_768)
        throw new EngineError('invalid-prompt', 409)
      const controller = new AbortController()
      const flight = { sessionId, key, requestId, context, prompt, controller, task: null, observed: {} }
      const row = { highWater: context.turnSeq, key, requestId, status: 'pending',
        token: null, suggestion: null, reservedAt: this.now(), accepted: false }
      this.ledger.sessions[sessionId] = row
      try { await this.persist() } catch {
        this.persistenceError = 'ledger-write-failed'
        throw new EngineError(this.persistenceError, 503)
      }
      if (!this.isEnabled() || requestSignal?.aborted || this.context(sessionId)?.key !== key) {
        row.status = 'cancelled'
        await this.persist().catch(() => { this.persistenceError = 'ledger-write-failed' })
        return this.state(sessionId)
      }
      this.active.set(sessionId, flight)
      this.flights.add(flight)
      // The predict response is immediate. The transient HTTP request's normal close
      // must not abort the detached inference; cancellation uses the explicit route.
      const onDisconnect = () => controller.abort(new Error('request-disconnected'))
      requestSignal?.addEventListener('abort', onDisconnect, { once: true })
      flight.task = this.run(flight).catch(() => { this.persistenceError = 'settlement-failed' })
        .finally(() => {
          requestSignal?.removeEventListener('abort', onDisconnect)
          this.flights.delete(flight)
        })
      return this.state(sessionId)
    })
  }

  async run(flight) {
    const { sessionId, key, requestId, controller, context, prompt } = flight
    const timeout = setTimeout(() => controller.abort(new Error('prediction-timeout')), this.timeoutMs)
    let outcome = null, failure = null
    try {
      const abort = new Promise((_, reject) => {
        if (controller.signal.aborted) reject(controller.signal.reason)
        else controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true })
      })
      outcome = await Promise.race([this.infer(context, prompt, controller.signal, metadata => {
        if (!flight.settled) Object.assign(flight.observed, metadata)
      }), abort])
      controller.signal.throwIfAborted()
    } catch (error) { failure = error }
    clearTimeout(timeout)
    await this.enqueue(async () => {
      const row = this.ledger.sessions[sessionId]
      const ownsRow = this.active.get(sessionId) === flight && row?.key === key && row.requestId === requestId
      if (this.active.get(sessionId) === flight) this.active.delete(sessionId)
      const stillCurrent = ownsRow && this.isEnabled() && this.context(sessionId)?.key === key
      let status, suggestion = null, token = null
      if (controller.signal.aborted || !stillCurrent) status = 'cancelled'
      else if (failure || outcome?.finish?.kind !== 'stop') status = 'failed'
      else {
        suggestion = this.normalizeSuggestion(outcome?.text, context)
        status = suggestion ? 'ready' : 'empty'
        token = suggestion ? this.uuid() : null
      }
      flight.settled = true
      if (ownsRow) Object.assign(row, { status, suggestion, token, settledAt: this.now() })
      // Every started request gets its own audit, even if a newer turn owns the row.
      this.ledger.audits.push({ sessionId, key, turnSeq: context.turnSeq, requestId,
        route: context.route, system: prompt.system, input: prompt.input,
        ...(outcome?.request || flight.observed.request ? { request: outcome?.request ?? flight.observed.request } : {}),
        usage: outcome?.usage ?? flight.observed.usage ?? null,
        finish: outcome?.finish ?? flight.observed.finish ?? null,
        status, suggestion,
        error: failure ? (controller.signal.aborted ? 'cancelled-or-timeout' : 'inference-failed') : null,
        time: this.now() })
      this.ledger.audits = this.ledger.audits.slice(-MAX_AUDITS)
      // Bound audit size without discarding the permanent reservation high-water marks.
      while (this.ledger.audits.length && Buffer.byteLength(JSON.stringify(this.ledger)) > MAX_LEDGER_BYTES)
        this.ledger.audits.shift()
      try { await this.persist() } catch {
        this.persistenceError = 'ledger-write-failed'
        if (ownsRow) { row.status = 'failed'; row.suggestion = null }
      }
    })
  }

  async cancel({ sessionId, key, requestId }) {
    await this.loaded
    return this.enqueue(async () => {
      this.context(sessionId)
      const flight = this.active.get(sessionId)
      if (flight && flight.key === key && flight.requestId === requestId)
        flight.controller.abort(new Error('prediction-cancelled'))
      return this.state(sessionId)
    })
  }

  async accepted({ sessionId, key, token }) {
    await this.loaded
    return this.enqueue(async () => {
      const state = this.state(sessionId)
      const row = this.ledger.sessions[sessionId]
      if (state.status === 'ready' && state.enabled && row?.key === key && row.token === token && !row.accepted) {
        row.accepted = true; row.acceptedAt = this.now()
        try { await this.persist() } catch { this.persistenceError = 'ledger-write-failed' }
      }
      return this.state(sessionId)
    })
  }

  invalidate(sessionId, reason = 'context-invalidated') {
    const flight = this.active.get(sessionId)
    flight?.controller.abort(new Error(reason))
  }

  disable() { for (const flight of this.active.values()) flight.controller.abort(new Error('disabled')) }

  async close() {
    this.closed = true; this.disable()
    await this.loaded
    await Promise.allSettled([...this.flights].map(flight => flight.task))
    await this.tail
    if (this.ownsLedger) {
      await this.lease.release()
      this.ownsLedger = false
    }
  }
}

export function validId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 160
    && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value)
    && !['__proto__', 'prototype', 'constructor'].includes(value)
}
