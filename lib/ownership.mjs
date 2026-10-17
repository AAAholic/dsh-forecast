import { readFile, mkdir, open, rename, link, unlink, chmod, realpath } from 'node:fs/promises'
import { dirname, basename, join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { createServer } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'

const KIND = 'loopback-v1'

// One fixed port per canonical ledger path. A collision stops generation; never
// select another port, because that would let two writers use the same ledger.
export function leasePort(identity) {
  return 15000 + createHash('sha256').update(identity).digest().readUInt32BE(0) % 15000
}

export async function syncDirectory(path) {
  let handle
  try { handle = await open(path, 'r'); await handle.sync() }
  catch (error) {
    // Windows does not expose directory fsync through this Node API.
    if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EISDIR', 'EINVAL'].includes(error?.code)) throw error
  } finally { await handle?.close() }
}

async function atomicJSON(path, value, exclusive = false) {
  const temporary = `${path}.${randomUUID()}.tmp`
  let handle
  try {
    handle = await open(temporary, 'wx', 0o600)
    await handle.writeFile(JSON.stringify(value)); await handle.sync()
    await handle.close(); handle = null
    if (exclusive) await link(temporary, path)
    else await rename(temporary, path)
    await syncDirectory(dirname(path))
  } finally { await handle?.close().catch(() => {}); await unlink(temporary).catch(() => {}) }
}

async function readJSON(path) {
  try { return JSON.parse(await readFile(path, 'utf8')) }
  catch (error) { if (error?.code === 'ENOENT') return null; if (error instanceof SyntaxError) return false; throw error }
}

function bind(port) {
  const server = createServer(socket => socket.destroy())
  server.maxConnections = 1
  server.unref()
  return new Promise((resolve, reject) => {
    const failed = error => { server.close(); reject(error) }
    server.once('error', failed)
    server.listen({ host: '127.0.0.1', port, exclusive: true }, () => {
      server.removeListener('error', failed)
      resolve(server)
    })
  })
}

/** OS lifetime lease, with metadata only for migration/diagnostics, never liveness. */
export async function acquireLedgerLease(ledgerPath, token, { waitMs = 2000, onError = () => {} } = {}) {
  await mkdir(dirname(ledgerPath), { recursive: true, mode: 0o700 })
  await chmod(dirname(ledgerPath), 0o700)
  let identity = join(await realpath(dirname(ledgerPath)), basename(ledgerPath))
  if (process.platform === 'win32') identity = identity.toLowerCase()
  const port = leasePort(identity), ownerPath = `${ledgerPath}.owner`, markerPath = `${ownerPath}.lease`
  let server
  const deadline = Date.now() + waitMs
  while (!server) {
    try { server = await bind(port) }
    catch (error) {
      if (error?.code !== 'EADDRINUSE' || Date.now() >= deadline) throw error
      await delay(Math.min(25, Math.max(1, deadline - Date.now())))
    }
  }
  server.on('error', onError)
  const close = () => new Promise(resolve => server.close(resolve))
  try {
    let owner = await readJSON(ownerPath)
    const marker = await readJSON(markerPath)
    const knownLease = marker?.kind === KIND && marker.identity === identity && marker.port === port
    let published = false
    for (let attempt = 0; attempt < 3 && !published; attempt++) {
      if (owner?.kind === KIND) {
        if (owner.identity !== identity || owner.port !== port) throw new Error('owner-identity-mismatch')
        // Binding proves no v2 owner remains, even if its PID has been reused.
      } else if (owner && Number.isSafeInteger(owner.pid) && owner.pid > 0 && typeof owner.token === 'string') {
        // v0.1.1 has no OS lease. Do not overlap a still-live old runtime.
        try { process.kill(owner.pid, 0); throw new Error('legacy-owner-live') }
        catch (error) { if (error?.code !== 'ESRCH') throw error }
      } else if (owner !== null && !knownLease) {
        // An unknown old lock cannot be safely reclaimed while its writer may live.
        throw new Error('legacy-owner-unverifiable')
      }
      try {
        // Publishing an absent owner must not overwrite a legacy wx writer that
        // appeared after our read. Existing v1 recovery races still require the
        // documented full old-runtime shutdown before first migration.
        await atomicJSON(ownerPath, { kind: KIND, identity, port, pid: process.pid, token }, owner === null)
        published = true
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error
        owner = await readJSON(ownerPath)
      }
    }
    if (!published) throw new Error('owner-changed-during-migration')
    // A durable marker distinguishes a corrupted v2 diagnostic from an unknown
    // legacy lock. The old empty .recovery file no longer participates in locking.
    await atomicJSON(markerPath, { kind: KIND, identity, port })
    let released = false
    return { port, get active() { return !released && server.listening }, async release() {
      if (released) return
      released = true
      try {
        const current = await readJSON(ownerPath)
        if (current?.token === token) await unlink(ownerPath)
      } catch {}
      await close()
    } }
  } catch (error) { await close(); throw error }
}
