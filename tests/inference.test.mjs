import test from 'node:test'
import assert from 'node:assert/strict'
import { createInference } from '../lib/inference.mjs'

class Assembler {
  content = new Map()
  _finish
  get finish() { return this._finish ?? { kind: 'stop' } }
  push(chunk) {
    if (chunk.type === 'text-delta') {
      const block = this.content.get(chunk.index) ?? { type: 'text', text: '' }
      block.text += chunk.text; this.content.set(chunk.index, block)
    }
    if (chunk.type === 'block-end') this.content.set(chunk.index, chunk.block)
    if (chunk.type === 'usage') this.usage = chunk.usage
    if (chunk.type === 'finish') this._finish = chunk.reason
  }
  blocks() { return [...this.content.values()] }
}
const dependencies = { BlockAssembler: Assembler, createUserMessage: input => ({ role: 'user', ...input }) }
const context = { route: { provider: 'mock', model: 'small' }, sessionId: 'session-1' }
const prompt = { system: 'system fixture', input: 'input fixture' }

test('one prepared registration supplies capabilities, exact dispatch controls and audit', async () => {
  let preparations = 0, streams = 0, observedRequest
  const reports = []
  const infer = createInference({ async prepareCall(config, signal, configure) {
    preparations++
    const controls = configure(Object.freeze({ maxTokens: config.maxTokens }),
      { reasoning: { efforts: [{ id: 'high' }, { id: 'low' }, { id: 'off' }] } })
    assert.deepEqual(controls, { maxTokens: 512, reasoningEffort: 'off' })
    return { config: { ...config, ...controls }, stream: async function* (request) {
      streams++; observedRequest = request
      yield { type: 'text-delta', index: 0, text: '{"suggestion":"继续审核当前接口。"}' }
      yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 8 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    } }
  } }, dependencies)
  const result = await infer(context, prompt, new AbortController().signal, value => reports.push(value))
  assert.equal(preparations, 1); assert.equal(streams, 1)
  assert.equal(observedRequest.reasoningEffort, 'off'); assert.equal(observedRequest.maxTokens, 512)
  assert.deepEqual(observedRequest.tools, [])
  assert.equal(observedRequest.messages[0].source.kind, 'dsh-forecast')
  assert.equal(result.finish.kind, 'stop'); assert.deepEqual(result.usage, { inputTokens: 10, outputTokens: 8 })
  assert.equal(reports.at(-1).finish.kind, 'stop')
})

test('cancellation during preparation prevents dispatch and does not retry', async () => {
  const controller = new AbortController(); let streams = 0, preparations = 0
  const infer = createInference({ async prepareCall() {
    preparations++; controller.abort()
    return { config: context.route, stream: () => { streams++; throw new Error('must not dispatch') } }
  } }, dependencies)
  const result = await infer(context, prompt, controller.signal, () => {})
  assert.equal(result.finish.kind, 'aborted'); assert.equal(streams, 0); assert.equal(preparations, 1)
})

test('unexpected tool output or a throwing stream cannot reuse a successful finish', async () => {
  for (const mode of ['tool', 'throw']) {
    const infer = createInference({ async prepareCall(config, signal, configure) {
      assert.deepEqual(configure({ maxTokens: 512 }, {}), { maxTokens: 512 })
      return { config, stream: async function* () {
        if (mode === 'tool') yield { type: 'block-end', index: 0,
          block: { type: 'tool-call', id: 'mock-tool', name: 'mock', arguments: '{}' } }
        yield { type: 'finish', reason: { kind: 'stop' } }
        if (mode === 'tool') return
        else throw new Error('consumer failure after finish')
      } }
    } }, dependencies)
    const result = await infer(context, prompt, new AbortController().signal, () => {})
    assert.equal(result.text, ''); assert.equal(result.finish.kind, 'error')
  }
})

test('default assembler stop without an actual terminal chunk is never a successful result', async () => {
  assert.deepEqual(new Assembler().finish, { kind: 'stop' })
  for (const reason of [null, { kind: 'max-tokens' }, { kind: 'error' }]) {
    const reports = []
    const infer = createInference({ async prepareCall(config) {
      return { config, stream: async function* () {
        yield { type: 'text-delta', index: 0, text: '{"suggestion":"继续审核当前接口。"}' }
        if (reason) yield { type: 'finish', reason }
      } }
    } }, dependencies)
    const result = await infer(context, prompt, new AbortController().signal, value => reports.push(value))
    assert.equal(result.text, '')
    assert.notEqual(result.finish.kind, 'stop')
    if (!reason) assert.equal(reports.some(value => value.finish?.kind === 'stop'), false)
  }
})

test('a successful terminal cannot be followed by more output or a replacement terminal', async () => {
  for (const extra of [{ type: 'text-delta', index: 0, text: 'late' }, { type: 'finish', reason: { kind: 'stop' } }]) {
    const infer = createInference({ async prepareCall(config) {
      return { config, stream: async function* () {
        yield { type: 'text-delta', index: 0, text: '{"suggestion":"继续审核当前接口。"}' }
        yield { type: 'finish', reason: { kind: 'stop' } }
        yield extra
      } }
    } }, dependencies)
    const result = await infer(context, prompt, new AbortController().signal, () => {})
    assert.equal(result.text, ''); assert.equal(result.finish.kind, 'error')
  }
})
