import { PredictionEngine } from '../../lib/engine.mjs'
const engine = new PredictionEngine({ ledgerPath: process.argv[2], ownerWaitMs: 100,
  getContext: () => ({ key: 'turn-12', turnSeq: 12, route: { provider: 'mock', model: 'mock' } }),
  buildPrompt: () => ({ system: '', input: '' }), normalizeSuggestion: () => null,
  infer: () => { console.log('mock-inference'); return new Promise(() => {}) },
})
await engine.loaded
if (engine.persistenceError) throw new Error(engine.persistenceError)
await engine.predict({ sessionId: 'session-1', key: 'turn-12', requestId: 'crash-request' })
console.log('ready')
process.stdin.resume()
