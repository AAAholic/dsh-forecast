import z from '@deepseek-ai/schemastery'
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { createHash } from 'node:crypto'
import { PredictionEngine, EngineError, validId } from './engine.mjs'
import { getContext, buildPrompt, normalizeSuggestion } from './policy.mjs'
import { createInference } from './inference.mjs'

export const name = 'dsh-forecast'
export const inject = ['sessions', 'sessionProjections', 'settings', 'llm', 'connection']
export const Config = z.object({ enabled: z.boolean().default(true) }).volatile()
const PREFIX = '/api/dsh-forecast'
const MAX_BODY = 2048

function reply(value, status = 200) {
  return Response.json(value, { status, headers: { 'cache-control': 'no-store' } })
}

async function bodyOf(request, fields) {
  const declared = Number(request.headers.get('content-length') ?? 0)
  if (declared > MAX_BODY) throw new EngineError('body-too-large', 413)
  const text = await request.text()
  if (Buffer.byteLength(text, 'utf8') > MAX_BODY) throw new EngineError('body-too-large', 413)
  let body
  try { body = JSON.parse(text) } catch { throw new EngineError('invalid-json') }
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || Object.keys(body).length !== fields.length || fields.some(field => typeof body[field] !== 'string')
    || Object.keys(body).some(field => !fields.includes(field))
    || !validId(body.sessionId) || body.key.length > 512
    || fields.some(field => body[field].length === 0)) throw new EngineError('invalid-body')
  if (body.requestId !== undefined && !validId(body.requestId)) throw new EngineError('invalid-request-id')
  if (body.token !== undefined && !validId(body.token)) throw new EngineError('invalid-token')
  return body
}

export function apply(ctx, config = Config({})) {
  const enabled = () => config.get().enabled === true
  const profile = createHash('sha256').update(String(ctx.baseUrl ?? process.env.DSH_PROFILE ?? 'desktop')).digest('hex').slice(0, 16)
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  const engine = new PredictionEngine({
    ledgerPath: join(home, 'data', 'dsh-forecast', profile, 'ledger.json'),
    enabled,
    getContext: sessionId => {
      const session = ctx.sessions.get(sessionId)
      if (!session) return null
      return getContext(session, ctx.sessionProjections.stateOf(session, 'modelSelection'))
    },
    buildPrompt, normalizeSuggestion,
    infer: createInference(ctx.llm, { BlockAssembler, createUserMessage }),
  })
  ctx.effect(() => ctx.settings.configure({ auto: false }), 'dsh-forecast: one-switch settings')
  let lastEnabled = enabled()
  const syncEnabled = () => {
    const next = enabled()
    if (lastEnabled && !next) engine.disable()
    lastEnabled = next
  }
  const interval = setInterval(syncEnabled, 250)
  interval.unref?.()
  ctx.on('settings/document-updated', syncEnabled)
  ctx.on('session/event', (session, event) => {
    if (['turn/start', 'user/message', 'model/selection', 'plan/mode', 'agent-preset/selected', 'surface/replace'].includes(event.type)
      || event.type.startsWith('goal/'))
      engine.invalidate(String(session.id))
  })
  ctx.on('session/disposed', session => { engine.invalidate(String(session?.id ?? session?.session?.id ?? '')) })

  const wrap = handler => async request => {
    syncEnabled()
    try { return reply(await handler(request)) }
    catch (error) {
      if (error instanceof EngineError) return reply({ error: error.code }, error.status)
      return reply({ error: 'unavailable' }, 503)
    }
  }
  ctx.connection.fetch.register({ path: `${PREFIX}/state`, methods: ['GET'], requestBody: 'buffered',
    fetch: wrap(request => {
      const url = new URL(request.url)
      if ([...url.searchParams.keys()].some(key => key !== 'sessionId') || url.searchParams.getAll('sessionId').length !== 1)
        throw new EngineError('invalid-query')
      return engine.getState(url.searchParams.get('sessionId'))
    }) })
  ctx.connection.fetch.register({ path: `${PREFIX}/predict`, methods: ['POST'], requestBody: 'buffered',
    fetch: wrap(async request => engine.predict(await bodyOf(request, ['sessionId', 'key', 'requestId']), request.signal)) })
  ctx.connection.fetch.register({ path: `${PREFIX}/cancel`, methods: ['POST'], requestBody: 'buffered',
    fetch: wrap(async request => engine.cancel(await bodyOf(request, ['sessionId', 'key', 'requestId']))) })
  ctx.connection.fetch.register({ path: `${PREFIX}/accepted`, methods: ['POST'], requestBody: 'buffered',
    fetch: wrap(async request => engine.accepted(await bodyOf(request, ['sessionId', 'key', 'token']))) })
  ctx.effect(() => async () => { clearInterval(interval); await engine.close() }, 'dsh-forecast: abort and flush')
}
