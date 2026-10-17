import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, readFile, writeFile, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer, createConnection } from 'node:net'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import fsPromises from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { acquireLedgerLease, leasePort } from '../lib/ownership.mjs'
import { PredictionEngine } from '../lib/engine.mjs'

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-lease-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return join(dir, 'ledger.json')
}
const take = (path, token = 'test-owner') => acquireLedgerLease(path, token, { waitMs: 60 })
const options = path => ({ ledgerPath: path, ownerWaitMs: 60,
  getContext: () => ({ key: 'turn-12', turnSeq: 12, route: { provider: 'mock', model: 'mock' } }),
  buildPrompt: () => ({ system: '', input: '' }), normalizeSuggestion: () => null,
  infer: () => { throw new Error('must not call') },
})

test('one OS lease rejects overlapping writers even with empty metadata, and releases cleanly', async t => {
  const path = await fixture(t), first = await take(path)
  t.after(() => first.release())
  await writeFile(`${path}.owner`, '')
  await assert.rejects(take(path, 'other'), { code: 'EADDRINUSE' })
  await first.release()
  const next = await take(path, 'next'); await next.release()
})

test('stale recovery files, corrupt v2 metadata and reused PIDs cannot permanently lock the ledger', async t => {
  const path = await fixture(t), first = await take(path)
  const owner = JSON.parse(await readFile(`${path}.owner`, 'utf8'))
  await first.release()
  // PID is deliberately alive, but no OS lease belongs to it now.
  await writeFile(`${path}.owner`, JSON.stringify({ ...owner, pid: process.pid }))
  // Crash after publishing owner but before publishing its marker.
  await rm(`${path}.owner.lease`)
  const second = await take(path); await second.release()
  await writeFile(`${path}.owner`, '{incomplete')
  await writeFile(`${path}.owner.recovery`, '')
  const third = await take(path); await third.release()
})

test('legacy owner appearing between read and publish is never overwritten', async t => {
  const path = await fixture(t), legacy = { pid: process.pid, token: 'legacy-racing-owner' }
  const original = fsPromises.link
  let injected = false
  const mocked = t.mock.method(fsPromises, 'link', async (from, to) => {
    if (to === `${path}.owner` && !injected) {
      injected = true
      await writeFile(to, JSON.stringify(legacy), { flag: 'wx', mode: 0o600 })
    }
    return original(from, to)
  })
  syncBuiltinESMExports()
  try {
    await assert.rejects(take(path), /legacy-owner-live/)
    assert.equal(injected, true)
    assert.deepEqual(JSON.parse(await readFile(`${path}.owner`, 'utf8')), legacy)
    await assert.rejects(readFile(`${path}.owner.lease`), { code: 'ENOENT' })
  } finally { mocked.mock.restore(); syncBuiltinESMExports() }
})

test('legacy live or unverifiable owners fail closed; a dead legacy owner migrates', async t => {
  const path = await fixture(t)
  await writeFile(`${path}.owner`, JSON.stringify({ pid: process.pid, token: 'v1-owner' }))
  await assert.rejects(take(path), /legacy-owner-live/)
  await writeFile(`${path}.owner`, '')
  await assert.rejects(take(path), /legacy-owner-unverifiable/)
  // Obtain an actually exited PID rather than assume a large PID is unused.
  const child = spawn(process.execPath, ['--expose-internals', '-e', 'process.exit(0)'], { env: process.env })
  await once(child, 'exit')
  await writeFile(`${path}.owner`, JSON.stringify({ pid: child.pid, token: 'dead-v1' }))
  const lease = await take(path); await lease.release()
})

test('same-process remount waits for orderly predecessor disposal', async t => {
  const path = await fixture(t), first = new PredictionEngine(options(path))
  await first.loaded; assert.equal(first.persistenceError, null)
  const next = new PredictionEngine({ ...options(path), ownerWaitMs: 500 })
  await delay(30); await first.close(); await next.loaded
  assert.equal(next.persistenceError, null)
  assert.equal((await next.getState('session-1')).canGenerate, true)
  await next.close()
  const final = await take(path); await final.release()
})

test('an occupied derived port fails closed rather than choosing another lock', async t => {
  const path = await fixture(t), identity = join(await realpath(join(path, '..')), 'ledger.json')
  const blocker = createServer(socket => socket.destroy())
  blocker.listen({ host: '127.0.0.1', port: leasePort(identity), exclusive: true })
  await once(blocker, 'listening')
  try { await assert.rejects(take(path), { code: 'EADDRINUSE' }) }
  finally { await new Promise(resolve => blocker.close(resolve)) }
  const lease = await take(path); await lease.release()
})

test('two different ledger paths with the same hash port remain mutually exclusive', async t => {
  const path = await fixture(t), root = await realpath(join(path, '..'))
  const firstPath = join(root, 'first', 'ledger.json')
  const port = leasePort(firstPath)
  let collision
  for (let i = 0; i < 200000; i++) {
    const candidate = join(root, `candidate-${i}`, 'ledger.json')
    if (leasePort(candidate) === port) { collision = candidate; break }
  }
  assert.ok(collision, 'find a deterministic hash collision')
  const first = await take(firstPath)
  try { await assert.rejects(take(collision), { code: 'EADDRINUSE' }) }
  finally { await first.release() }
  const second = await take(collision); await second.release()
})

test('metadata I/O errors release the OS lease for a later healthy startup', async t => {
  const path = await fixture(t)
  await mkdir(`${path}.owner`)
  await assert.rejects(take(path))
  await rm(`${path}.owner`, { recursive: true })
  const lease = await take(path); await lease.release()
})

test('lease socket immediately closes connections without a protocol or response', async t => {
  const path = await fixture(t), lease = await take(path)
  try {
    const socket = createConnection({ host: '127.0.0.1', port: lease.port })
    let bytes = 0
    socket.on('data', chunk => { bytes += chunk.length })
    socket.on('error', error => { assert.equal(error.code, 'ECONNRESET') })
    await once(socket, 'close'); assert.equal(bytes, 0)
  } finally { await lease.release() }
})

test('cross-process crash releases exclusivity while preserving the spent turn reservation', async t => {
  const path = await fixture(t)
  const child = spawn(process.execPath, ['--expose-internals', fileURLToPath(new URL('./fixtures/lease-owner.mjs', import.meta.url)), path],
    { env: process.env, stdio: ['pipe', 'pipe', 'pipe'] })
  let output = '', errors = ''
  child.stderr.on('data', chunk => { errors += chunk })
  t.after(() => { child.kill('SIGKILL') })
  await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', code => reject(new Error(`child exited ${code}: ${errors}`)))
    child.stdout.on('data', chunk => { output += chunk; if (output.includes('ready\n')) resolve() })
  })
  assert.equal(output.match(/mock-inference/g)?.length, 1)
  const competing = new PredictionEngine(options(path))
  await competing.loaded
  assert.equal(competing.persistenceError, 'ledger-owned-or-unavailable')
  assert.equal((await competing.getState('session-1')).canGenerate, false)
  await competing.close()
  // Neither a truncated diagnostic nor the obsolete recovery mutex can bypass
  // the live process, or prevent recovery after its actual death.
  await writeFile(`${path}.owner`, '')
  await writeFile(`${path}.owner.recovery`, '')
  const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited
  let calls = 0
  const recovered = new PredictionEngine({ ...options(path), infer: () => { calls++; throw new Error('must not call') } })
  await recovered.loaded
  assert.equal(recovered.persistenceError, null)
  assert.equal((await recovered.getState('session-1')).status, 'failed')
  await recovered.predict({ sessionId: 'session-1', key: 'turn-12', requestId: 'attempted-retry' })
  assert.equal(calls, 0)
  await recovered.close()
})
