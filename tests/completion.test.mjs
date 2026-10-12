import test from 'node:test'
import assert from 'node:assert/strict'
import { PredictionController } from '../lib/client/controller.mjs'

const context = { sessionId: 'test', modeKey: 'standard', session: {
  sessionId: 'test', openState: 'open', running: false, blank: false,
  removed: false, subagent: null, pendingSubmissions: [],
}, input: { draft: '', phase: 'plain', attachmentIds: [], occurrences: [], draftRev: 0 } }
const scope = { getSnapshot: () => ({ status: 'ready', value: { enabled: true } }), subscribe: () => () => {} }
const response = payload => ({ ok: true, json: async () => payload })

test('completion status arriving before the durable event causes bounded read-only checks, then one prediction', async () => {
  let reads = 0, predicts = 0, scheduled
  const controller = new PredictionController({ settingsScope: scope,
    schedule: fn => { scheduled = fn; return 1 }, clear: () => {},
    fetcher: async url => {
      if (url.includes('/state?')) {
        reads++
        return response({ enabled: true, sessionId: 'test', key: reads === 1 ? null : 'finished',
          status: 'idle', canGenerate: reads !== 1 })
      }
      if (url.endsWith('/predict')) predicts++
      return response({ enabled: true, sessionId: 'test', key: 'finished', status: 'empty', canGenerate: false })
    } })
  controller.updateContext(context); await controller.flight
  assert.equal(predicts, 0); assert.equal(reads, 1)
  scheduled(); await controller.flight
  assert.equal(reads, 2); assert.equal(predicts, 1)
  await controller.read(); assert.equal(predicts, 1)
  controller.dispose()
})

test('unavailable completed context stops state checks without attempting inference', async () => {
  let reads = 0, predicts = 0, scheduled
  const controller = new PredictionController({ settingsScope: scope,
    schedule: fn => { scheduled = fn; return 1 }, clear: () => { scheduled = null },
    fetcher: async url => {
      if (url.endsWith('/predict')) predicts++
      reads++
      return response({ enabled: true, sessionId: 'test', key: null, status: 'idle', canGenerate: false })
    } })
  controller.updateContext(context); await controller.flight
  while (scheduled) { const next = scheduled; scheduled = null; next(); await controller.flight }
  assert.equal(reads, 9); assert.equal(predicts, 0)
  controller.dispose()
})
