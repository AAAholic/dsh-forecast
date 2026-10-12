import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile, writeFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PredictionEngine, EngineError } from '../lib/engine.mjs'

const completed = (turnSeq = 12, key = `turn-${turnSeq}`) => ({ key, turnSeq,
  route: { provider: 'configured-provider', model: 'configured-model' }, history: [] })
const success = text => ({ text, finish: { kind: 'stop' }, usage: { inputTokens: 21, outputTokens: 12 },
  request: { provider: 'configured-provider', model: 'configured-model', maxTokens: 512 } })
const deferred = () => { let resolve; const promise = new Promise(value => { resolve = value }); return { promise, resolve } }

async function setup(t, overrides = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-prediction-engine-'))
  const ledgerPath = join(dir, 'private', 'ledger.json')
  let context = completed(), calls = 0, enabled = true
  const pending = deferred()
  const engine = new PredictionEngine({ ledgerPath, getContext: () => context,
    buildPrompt: () => ({ system: 'Predict one short plain-text next input.', input: 'User and assistant text.' }),
    normalizeSuggestion: text => typeof text === 'string' && text.trim() ? text.trim() : null,
    infer: (...args) => { calls++; return pending.promise }, enabled: () => enabled,
    ...overrides })
  await engine.loaded
  t.after(async () => { await engine.close(); await rm(dir, { recursive: true, force: true }) })
  return { engine, ledgerPath, pending, get calls() { return calls }, setContext: next => { context = next },
    disable: () => { enabled = false; engine.disable() } }
}

const request = (key = 'turn-12', requestId = 'request-1', sessionId = 'session-1') => ({ sessionId, key, requestId })

test('GET is read-only; concurrent predict reserves once before invoking the model', async t => {
  const f = await setup(t)
  assert.equal((await f.engine.getState('session-1')).canGenerate, true)
  assert.equal(f.calls, 0)
  const [a, b] = await Promise.all([f.engine.predict(request()), f.engine.predict(request('turn-12', 'request-2'))])
  assert.equal(a.status, 'pending'); assert.equal(b.status, 'pending'); assert.equal(f.calls, 1)
  const saved = JSON.parse(await readFile(f.ledgerPath, 'utf8'))
  assert.equal(saved.sessions['session-1'].highWater, 12)
  assert.equal(saved.sessions['session-1'].status, 'pending')
  // Windows file privacy follows directory ACLs, not POSIX owner/group mode bits.
  if (process.platform !== 'win32') assert.equal((await stat(f.ledgerPath)).mode & 0o777, 0o600)
  const flight = f.engine.active.get('session-1')
  f.pending.resolve(success('请先完成验证并展示结果。'))
  await flight.task
  assert.equal((await f.engine.getState('session-1')).suggestion, '请先完成验证并展示结果。')
  assert.equal((await f.engine.predict(request())).status, 'ready'); assert.equal(f.calls, 1)
})

test('an accepted token is idempotent and cached text remains available for re-editing', async t => {
  const f = await setup(t)
  await f.engine.predict(request()); const flight = f.engine.active.get('session-1')
  f.pending.resolve(success('检查刚才的结果。')); await flight.task
  const state = await f.engine.getState('session-1')
  const args = { sessionId: state.sessionId, key: state.key, token: state.token }
  await f.engine.accepted(args); const acceptedAt = f.engine.ledger.sessions['session-1'].acceptedAt
  await f.engine.accepted(args)
  assert.equal(f.engine.ledger.sessions['session-1'].acceptedAt, acceptedAt)
  assert.equal((await f.engine.getState('session-1')).suggestion, state.suggestion)
  assert.equal(f.calls, 1)
})

test('cancel is request-id fenced; old request cannot cancel the current inference', async t => {
  const f = await setup(t)
  await f.engine.predict(request()); const flight = f.engine.active.get('session-1')
  await f.engine.cancel(request('turn-12', 'old-request'))
  assert.equal(flight.controller.signal.aborted, false)
  await f.engine.cancel(request())
  await flight.task
  assert.equal((await f.engine.getState('session-1')).status, 'cancelled')
  assert.equal((await f.engine.predict(request('turn-12', 'new-request'))).canGenerate, false)
  assert.equal(f.calls, 1)
  f.pending.resolve(success('late result'))
})

test('semantic change discards late successful output even when the adapter ignores abort', async t => {
  const f = await setup(t)
  await f.engine.predict(request()); const flight = f.engine.active.get('session-1')
  f.setContext(completed(18)); f.engine.invalidate('session-1')
  await flight.task
  f.pending.resolve(success('stale result'))
  await Promise.resolve()
  const state = await f.engine.getState('session-1')
  assert.equal(state.key, 'turn-18'); assert.equal(state.suggestion, null)
  assert.equal(f.engine.ledger.sessions['session-1'].status, 'cancelled')
})

test('disabled and malformed contexts refuse generation without making a model request', async t => {
  const f = await setup(t)
  f.setContext(null)
  await assert.rejects(f.engine.predict(request()), error => error instanceof EngineError && error.code === 'stale-context')
  f.setContext(completed()); f.disable()
  assert.equal((await f.engine.predict(request())).enabled, false)
  assert.equal(f.calls, 0)
})

test('timeout settles failed closed and does not permit a second inference', async t => {
  const f = await setup(t, { timeoutMs: 20 })
  await f.engine.predict(request()); const flight = f.engine.active.get('session-1')
  await flight.task
  assert.equal((await f.engine.getState('session-1')).status, 'cancelled')
  assert.equal((await f.engine.predict(request('turn-12', 'retry'))).canGenerate, false)
  assert.equal(f.calls, 1)
  f.pending.resolve(success('late'))
})

test('reload cannot repeat a reserved request after process loss; high-water never regresses', async t => {
  const f = await setup(t)
  await f.engine.predict(request()); const flight = f.engine.active.get('session-1')
  const reserved = await readFile(f.ledgerPath, 'utf8')
  f.engine.invalidate('session-1'); await flight.task; await f.engine.close()
  // Simulate a process loss with the last persisted state still pending.
  await writeFile(f.ledgerPath, reserved, { mode: 0o600 })
  const second = new PredictionEngine({ ledgerPath: f.ledgerPath, getContext: () => completed(),
    buildPrompt: () => ({ system: '', input: '' }), normalizeSuggestion: text => text,
    infer: () => { throw new Error('must not call') } })
  await second.loaded
  assert.equal((await second.getState('session-1')).status, 'failed')
  assert.equal((await second.predict(request())).canGenerate, false)
  second.getContext = () => completed(3)
  assert.equal((await second.getState('session-1')).canGenerate, false)
  await second.close()
  f.pending.resolve(success('late'))
})

test('a second process owner is refused before spending tokens', async t => {
  const f = await setup(t)
  const second = new PredictionEngine({ ledgerPath: f.ledgerPath, getContext: () => completed(),
    buildPrompt: () => ({ system: '', input: '' }), normalizeSuggestion: text => text,
    infer: () => { throw new Error('must not call') } })
  await second.loaded
  assert.equal((await second.getState('session-1')).canGenerate, false)
  await assert.rejects(second.predict(request()), error => error.code === 'ledger-owned-or-unavailable')
  await second.close()
})

test('global concurrent request budget refuses extra sessions before reserving their turn', async t => {
  const f = await setup(t, { maxConcurrent: 1 })
  await f.engine.predict(request())
  await assert.rejects(f.engine.predict(request('turn-12', 'request-2', 'session-2')),
    error => error.code === 'busy' && error.status === 429)
  assert.equal(f.engine.ledger.sessions['session-2'], undefined); assert.equal(f.calls, 1)
  f.pending.resolve(success('check result'))
  await f.engine.active.get('session-1').task
})

test('bad ledger fails closed and never resets its token-spending reservations', async t => {
  const f = await setup(t)
  await f.engine.predict(request()); const flight = f.engine.active.get('session-1')
  f.engine.invalidate('session-1'); await flight.task
  await f.engine.close()
  await writeFile(f.ledgerPath, '{corrupt')
  const second = new PredictionEngine({ ledgerPath: f.ledgerPath, getContext: () => completed(),
    buildPrompt: () => ({ system: '', input: '' }), normalizeSuggestion: text => text,
    infer: () => { throw new Error('must not call') } })
  await second.loaded
  assert.equal((await second.getState('session-1')).canGenerate, false)
  await assert.rejects(second.predict(request()), error => error.code === 'ledger-unavailable')
  await second.close(); f.pending.resolve(success('late'))
})

test('owner handoff reloads the reservations made by the departing owner', async t => {
  const f = await setup(t)
  await f.engine.close()
  class HandoffEngine extends PredictionEngine {
    async acquireOwner() {
      await super.acquireOwner()
      // Emulate a reservation committed at the handoff boundary.
      await writeFile(this.ledgerPath, JSON.stringify({ version: 1, sessions: {
        'session-1': { highWater: 12, key: 'turn-12', requestId: 'old-request', status: 'failed' },
      }, audits: [] }), { mode: 0o600 })
    }
  }
  let calls = 0
  const second = new HandoffEngine({ ledgerPath: f.ledgerPath, getContext: () => completed(),
    buildPrompt: () => ({ system: '', input: '' }), normalizeSuggestion: text => text,
    infer: () => { calls++; return success('never') } })
  await second.loaded
  assert.equal((await second.getState('session-1')).canGenerate, false)
  await second.predict(request()); assert.equal(calls, 0)
  await second.close()
})

test('a newer turn cannot erase the cancellation audit of an older request', async t => {
  const f = await setup(t)
  await f.engine.predict(request())
  const old = f.engine.active.get('session-1')
  f.setContext(completed(18)); f.engine.invalidate('session-1')
  await f.engine.predict(request('turn-18', 'request-2'))
  const next = f.engine.active.get('session-1')
  await old.task
  f.pending.resolve(success('请核对当前结果。')); await next.task
  const audits = f.engine.ledger.audits
  assert.equal(audits.length, 2)
  assert.equal(audits.find(row => row.requestId === 'request-1').status, 'cancelled')
  assert.equal(audits.find(row => row.requestId === 'request-2').status, 'ready')
  assert.equal((await f.engine.getState('session-1')).suggestion, '请核对当前结果。')
})

test('private audit contains exact request inputs, route, usage and terminal result', async t => {
  const f = await setup(t)
  await f.engine.predict(request()); const flight = f.engine.active.get('session-1')
  f.pending.resolve(success('请展示验证结果。')); await flight.task
  const saved = JSON.parse(await readFile(f.ledgerPath, 'utf8'))
  const audit = saved.audits.at(-1)
  assert.equal(audit.system, 'Predict one short plain-text next input.')
  assert.equal(audit.input, 'User and assistant text.')
  assert.deepEqual(audit.route, completed().route)
  assert.equal(audit.request.maxTokens, 512)
  assert.deepEqual(audit.usage, { inputTokens: 21, outputTokens: 12 })
  assert.deepEqual(audit.finish, { kind: 'stop' })
  assert.equal(audit.status, 'ready')
})

test('non-stop terminal output is never offered and is never retried', async t => {
  const f = await setup(t)
  await f.engine.predict(request()); const flight = f.engine.active.get('session-1')
  f.pending.resolve({ text: 'truncated candidate', finish: { kind: 'max-tokens' } })
  await flight.task
  const state = await f.engine.getState('session-1')
  assert.equal(state.status, 'failed'); assert.equal(state.suggestion, null)
  await f.engine.predict(request('turn-12', 'retry'))
  assert.equal(f.calls, 1)
})

test('disable aborts active work while preserving already observed request and usage in audit', async t => {
  let report, inferenceSignal
  const pending = deferred()
  const f = await setup(t, { infer: (context, prompt, signal, observer) => {
    report = observer; inferenceSignal = signal
    observer({ request: { ...context.route, maxTokens: 512, system: prompt.system, input: prompt.input },
      usage: { inputTokens: 17, outputTokens: 2 } })
    return pending.promise
  } })
  await f.engine.predict(request()); const flight = f.engine.active.get('session-1')
  f.disable(); await flight.task
  assert.equal(inferenceSignal.aborted, true)
  assert.equal((await f.engine.getState('session-1')).enabled, false)
  const audit = f.engine.ledger.audits.at(-1)
  assert.equal(audit.request.maxTokens, 512)
  assert.deepEqual(audit.usage, { inputTokens: 17, outputTokens: 2 })
  assert.equal(audit.finish, null)
  report({ usage: { inputTokens: 999, outputTokens: 999 } })
  assert.deepEqual(f.engine.ledger.audits.at(-1).usage, { inputTokens: 17, outputTokens: 2 })
  pending.resolve(success('too late'))
})
