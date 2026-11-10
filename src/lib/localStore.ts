import { openDB, type DBSchema } from 'idb'
import type { Ledger, Operation } from '../domain'

interface ChiaTienDB extends DBSchema {
  ledger: { key: 'current'; value: Ledger }
  operations: { key: string; value: Operation & { createdAt: number }; indexes: { createdAt: number } }
}

const dbPromise = openDB<ChiaTienDB>('chia-tien-v1', 1, {
  upgrade(db) {
    db.createObjectStore('ledger')
    const operations = db.createObjectStore('operations', { keyPath: 'opId' })
    operations.createIndex('createdAt', 'createdAt')
  },
})

export async function readLedger() { return (await dbPromise).get('ledger', 'current') }
export async function writeLedger(ledger: Ledger) { await (await dbPromise).put('ledger', ledger, 'current') }
export async function readQueue() { return (await dbPromise).getAllFromIndex('operations', 'createdAt') }
export async function queueOperation(operation: Operation) {
  const db = await dbPromise
  await db.put('operations', Object.assign(operation, { createdAt: Date.now() }))
}
export async function replaceOperation(operation: Operation) {
  const db = await dbPromise
  const old = await db.get('operations', operation.opId)
  if (old) await db.put('operations', { ...operation, createdAt: old.createdAt })
}
export async function removeOperation(opId: string) { await (await dbPromise).delete('operations', opId) }
export async function clearQueue() { await (await dbPromise).clear('operations') }
