import { LIMITS } from './policy.mjs'

export function createInference(llm, { BlockAssembler, createUserMessage }) {
  return async (context, prompt, signal, report) => {
    const messages = [createUserMessage({ content: [{ type: 'text', text: prompt.input }],
      source: { kind: 'dsh-forecast' } })]
    const assembler = new BlockAssembler()
    let terminal = null
    let request = { ...context.route, maxTokens: LIMITS.outputTokens, messages,
      system: prompt.system, tools: [], sessionId: context.sessionId }
    report({ request })
    try {
      // Choose controls from the captured adapter's capabilities, in the same
      // preparation that produces the one-shot stream. A separate metadata
      // lookup could belong to a different registration after hot reload.
      const prepared = await llm.prepareCall({ ...context.route, maxTokens: LIMITS.outputTokens }, signal,
        (controls, info) => {
          const supported = info.reasoning?.efforts?.map(effort => effort.id) ?? []
          const effort = ['off', 'none', 'minimal', 'low'].find(id => supported.includes(id))
          return { ...controls, ...(effort === undefined ? {} : { reasoningEffort: effort }) }
        })
      signal.throwIfAborted()
      request = { ...prepared.config, messages, system: prompt.system, tools: [], sessionId: context.sessionId }
      report({ request })
      for await (const chunk of prepared.stream({ ...request, signal })) {
        signal.throwIfAborted()
        if (terminal && chunk.type !== 'usage') throw new Error('chunk-after-finish')
        assembler.push(chunk)
        if (chunk.type === 'usage') report({ usage: assembler.usage })
        if (chunk.type === 'finish') {
          terminal = chunk.reason
          report({ finish: terminal })
        }
      }
      signal.throwIfAborted()
      // BlockAssembler defaults finish to stop when no terminal was received.
      // A complete-looking JSON body alone is not proof of successful inference.
      if (!terminal || typeof terminal.kind !== 'string') throw new Error('missing-finish')
      if (terminal.kind !== 'stop') return { text: '', usage: assembler.usage, finish: terminal, request }
      const blocks = assembler.blocks()
      if (blocks.some(block => block.type === 'tool-call')) throw new Error('unexpected-tool-call')
      return { text: blocks.filter(block => block.type === 'text').map(block => block.text).join(''),
        usage: assembler.usage, finish: terminal, request }
    } catch {
      return { text: '', usage: assembler.usage ?? null, request,
        // A consumer failure must never inherit an earlier successful finish.
        finish: { kind: signal.aborted ? 'aborted' : 'error',
          failure: { code: 'PREDICTION_FAILED', message: 'Prediction did not complete.' } } }
    }
  }
}
