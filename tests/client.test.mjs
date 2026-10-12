import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PredictionController, inputEmpty } from '../lib/client/controller.mjs'
import { acceptCandidate, tabGesture } from '../lib/client/acceptance.mjs'
import { SwitchSettingsForm } from '../lib/client/settings-model.mjs'
import { predictionModeKey } from '../lib/client/mode.mjs'

const ready = (sessionId = 'a', key = 'turn-1') => ({ enabled: true, sessionId, key,
  status: 'ready', token: `${sessionId}:${key}`, suggestion: '先检查现有实现，再给我一个可直接执行的方案。', canGenerate: false })
const idle = (sessionId = 'a', key = 'turn-1') => ({ ...ready(sessionId, key), status: 'idle', token: null, suggestion: null, canGenerate: true })
const input = (draft = '', draftRev = 0) => ({ draft, draftRev, phase: 'plain', attachmentIds: [], occurrences: [] })
const context = (sessionId = 'a', draft = '', draftRev = 0) => ({ sessionId, modeKey: 'normal',
  session: { sessionId, openState: 'open', running: false, blank: false, removed: false, subagent: null, pendingSubmissions: [] },
  input: input(draft, draftRev) })
const response = payload => ({ ok: true, json: async () => payload })
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }

function settings(enabled = true) {
  let snapshot = { status: 'ready', writable: true, value: { enabled } }
  const listeners = new Set(), writes = []
  return {
    writes, getSnapshot: () => snapshot,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    update(next) { snapshot = { ...snapshot, ...next }; for (const listener of listeners) listener() },
    async set(key, value) { writes.push([key, value]); this.update({ value: { ...snapshot.value, [key]: value } }); return true },
  }
}

function generatedFixture(modeKey = 'normal') {
  const calls = [], scope = settings()
  const controller = new PredictionController({ settingsScope: scope, fetcher: async (url, options) => {
    calls.push({ url, options })
    return response(url.includes('/state?') ? idle() : ready())
  } })
  controller.updateContext({ ...context(), modeKey })
  return { controller, calls, scope }
}

test('default browser APIs retain their Window receiver through lifecycle, polling and fetch', async () => {
  const saved = { fetch: globalThis.fetch, setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout }
  const calls = []
  let controller
  try {
    for (const method of ['fetch', 'setTimeout', 'clearTimeout']) {
      globalThis[method] = function (...args) {
        assert.equal(this, globalThis, `${method} requires its browser global receiver`)
        calls.push(method)
        if (method === 'fetch') return Promise.resolve(response({ ...idle(), canGenerate: false }))
        if (method === 'setTimeout') return 1
      }
    }
    controller = new PredictionController({ settingsScope: settings(), autoConnect: false })
    controller.updateContext(context())
    controller.connect()
    await controller.flight
    controller.poll(controller.generation)
    controller.disconnect()
    for (const method of Object.keys(saved)) assert.ok(calls.includes(method))
  } finally {
    controller?.dispose()
    Object.assign(globalThis, saved)
  }
})

test('typing hides the cached candidate, deletion and repeated adoption reuse it without another generation', async () => {
  const { controller, calls } = generatedFixture()
  await controller.flight
  const candidate = controller.getSnapshot().candidate
  assert.equal(candidate.text, ready().suggestion)
  controller.updateContext(context('a', '自己写', 1))
  assert.equal(inputEmpty(controller.context.input), false)
  assert.equal(controller.getSnapshot().candidate, candidate)
  controller.updateContext(context('a', '', 2))
  assert.equal(inputEmpty(controller.context.input), true)
  assert.equal(controller.getSnapshot().candidate, candidate)
  controller.accepted(candidate); controller.accepted(candidate)
  await Promise.resolve()
  assert.equal(calls.filter(call => call.url.endsWith('/predict')).length, 1)
  assert.equal(calls.filter(call => call.url.endsWith('/accepted')).length, 1)
  controller.dispose()
})

test('a late prediction from a replaced session cannot publish and its request is cancelled', async () => {
  const pending = deferred(), calls = [], scope = settings()
  const controller = new PredictionController({ settingsScope: scope, fetcher: async (url, options) => {
    calls.push({ url, options })
    if (url.endsWith('/predict')) return pending.promise
    if (url.includes('sessionId=a')) return response(idle('a'))
    return response({ ...idle('b'), canGenerate: false, status: 'empty' })
  } })
  controller.updateContext(context('a'))
  await new Promise(resolve => setImmediate(resolve))
  const oldFlight = controller.flight
  const predictionCall = calls.find(call => call.url.endsWith('/predict'))
  controller.updateContext(context('b'))
  assert.equal(predictionCall.options.signal.aborted, true)
  const cancellation = calls.find(call => call.url.endsWith('/cancel'))
  assert.equal(JSON.parse(cancellation.options.body).requestId, JSON.parse(predictionCall.options.body).requestId)
  pending.resolve(response(ready('a')))
  await oldFlight
  await controller.flight
  assert.equal(controller.getSnapshot().candidate, null)
  assert.equal(controller.context.sessionId, 'b')
  controller.dispose()
})

test('turn activity and disabling the switch clear old ghosts and abort pending work', async () => {
  const { controller, scope } = generatedFixture()
  await controller.flight
  const old = controller.getSnapshot().candidate
  const active = context(); active.session.running = true
  controller.updateContext(active)
  assert.equal(controller.candidateCurrent(old), false)
  assert.equal(controller.getSnapshot().candidate, null)
  scope.update({ value: { enabled: false } })
  assert.equal(controller.enabled, false)
  assert.equal(controller.getSnapshot().candidate, null)
  controller.dispose()
})

test('failed generation is not automatically retried for the same turn', async () => {
  let generations = 0
  const controller = new PredictionController({ settingsScope: settings(), fetcher: async url => {
    if (url.endsWith('/predict')) { generations++; throw new Error('offline') }
    return response(idle())
  } })
  controller.updateContext(context())
  await controller.flight
  assert.equal(controller.getSnapshot().status, 'failed')
  await controller.read()
  assert.equal(generations, 1)
  assert.equal(controller.getSnapshot().candidate, null)
  controller.dispose()
})

test('changing modes suppresses a cached old key even if the Host still returns it', async () => {
  const { controller, calls } = generatedFixture()
  await controller.flight
  const next = context(); next.modeKey = 'plan'
  controller.updateContext(next)
  await controller.flight
  assert.equal(controller.getSnapshot().candidate, null)
  assert.equal(calls.filter(call => call.url.endsWith('/predict')).length, 1)
  controller.dispose()
})

test('a goal objective change in the same phase invalidates a ready ghost without another generation', async () => {
  const before = { goal: { goal: { phase: 'active', objective: '检查现有实现', id: 'goal-1' } }, plan: { active: false, pending: false } }
  const after = { ...before, goal: { goal: { phase: 'active', objective: '修改预测策略', id: 'goal-1' } } }
  assert.notEqual(predictionModeKey(before), predictionModeKey(after))
  assert.equal(predictionModeKey(before), predictionModeKey({ plan: { pending: false, active: false }, goal: before.goal }))
  assert.notEqual(predictionModeKey({ plan: { active: false, pending: false } }), predictionModeKey({ plan: { active: false, pending: 'awaiting-confirmation' } }))
  const { controller, calls } = generatedFixture(predictionModeKey(before))
  await controller.flight
  assert.ok(controller.getSnapshot().candidate)
  controller.updateContext({ ...context(), modeKey: predictionModeKey(after) })
  await controller.flight
  assert.equal(controller.getSnapshot().candidate, null)
  assert.equal(calls.filter(call => call.url.endsWith('/predict')).length, 1)
  controller.dispose()
})

test('adoption uses the current revision CAS, verifies committed text, and never submits', () => {
  const candidate = { text: '继续检查边界条件。' }, notifications = []
  const controller = { candidateCurrent: value => value === candidate, accepted: value => notifications.push(value) }
  let snapshot = input('', 4), inserts = 0
  const shell = { get snapshot() { return snapshot }, actions: {
    captureInsertion: () => ({ start: 0, end: 0, draftRev: snapshot.draftRev }),
    insertText(text, span) { inserts++; assert.equal(span.draftRev, 4); snapshot = input(text, 5); return true },
    submit() { assert.fail('Prediction must never submit') }, setDraft() { assert.fail('Prediction must use CAS insertion') },
  } }
  const args = { controller, candidate, shell, visible: true, composing: false, menuOpen: false, editable: true }
  assert.equal(acceptCandidate(args), true)
  assert.equal(snapshot.draft, candidate.text)
  assert.equal(inserts, 1)
  assert.deepEqual(notifications, [candidate])
  assert.equal(acceptCandidate(args), false)
  snapshot = input('', 4)
  shell.actions.captureInsertion = () => ({ start: 0, end: 0, draftRev: 3 })
  assert.equal(acceptCandidate(args), false)
  assert.equal(inserts, 1)
  for (const patch of [{ visible: false }, { composing: true }, { menuOpen: true }, { editable: false }]) {
    assert.equal(acceptCandidate({ ...args, ...patch }), false)
  }
})

test('only unmodified non-composing Tab can request adoption; Enter is never an adoption gesture', () => {
  const event = { key: 'Tab', shiftKey: false, ctrlKey: false, metaKey: false, altKey: false,
    defaultPrevented: false, isComposing: false, keyCode: 9, repeat: false }
  assert.equal(tabGesture(event), true)
  for (const patch of [{ key: 'Enter' }, { shiftKey: true }, { ctrlKey: true }, { metaKey: true },
    { altKey: true }, { isComposing: true }, { keyCode: 229 }, { repeat: true }, { defaultPrevented: true }]) {
    assert.equal(tabGesture({ ...event, ...patch }), false)
  }
  assert.equal(inputEmpty({ ...input(), attachmentIds: ['attachment'] }), false)
  assert.equal(inputEmpty({ ...input(), occurrences: ['reference'] }), false)
  assert.equal(inputEmpty({ ...input(), phase: 'submitting' }), false)
})

test('the single settings toggle persists immediately, blocks competing writes, and keeps snapshots stable', async () => {
  const scope = settings(), pending = deferred()
  scope.set = async (key, value) => { scope.writes.push([key, value]); await pending.promise; scope.update({ value: { enabled: value } }); return true }
  const form = new SwitchSettingsForm(scope)
  assert.equal(form.getSnapshot(), form.getSnapshot())
  const saving = form.toggle(false)
  assert.equal(form.getSnapshot().saving, true)
  await form.toggle(true)
  assert.deepEqual(scope.writes, [['enabled', false]])
  pending.resolve(); await saving
  assert.equal(form.getSnapshot().enabled, false)
  assert.equal(form.getSnapshot().failed, false)
  scope.update({ writable: false })
  await form.toggle(true)
  assert.equal(scope.writes.length, 1)
  scope.update({ writable: true })
  scope.set = async () => false
  await form.toggle(true)
  assert.equal(form.getSnapshot().failed, true)
  form.dispose()
})
