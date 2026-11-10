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

// NOTE(VI): Lý do: Tối ưu tải app tức thì (Instant App Launch - 0s): Lưu cache đồng bộ trong localStorage để nạp UI ngay khung hình đầu tiên, không phải chờ mạng Supabase hay IndexedDB
// Trước: Mở app phải chờ getSession() qua mạng và IndexedDB async -> màn hình "Đang mở sổ chi tiêu..." quay tròn 2-5 giây
// Sau: Đọc ngay bản lưu trong localStorage -> UI hiện ngay tức thì trong 0.05 giây; mạng đồng bộ ngầm phía sau
// Test: Tắt mở lại app -> Giao diện hiện ra ngay lập tức, không còn bị khựng ở màn hình loading
const LEDGER_STORAGE_KEY = 'chia-tien-cached-ledger'
const SESSION_STORAGE_KEY = 'chia-tien-cached-session'

export function readCachedLedgerSync(): Ledger | null {
  try {
    const raw = localStorage.getItem(LEDGER_STORAGE_KEY)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

export function writeCachedLedgerSync(ledger: Ledger): void {
  try {
    localStorage.setItem(LEDGER_STORAGE_KEY, JSON.stringify(ledger))
  } catch { /* ignore */ }
}

export function hasCachedSessionSync(): boolean {
  try {
    if (localStorage.getItem(SESSION_STORAGE_KEY) === 'true') return true
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (key && key.startsWith('sb-') && key.endsWith('-auth-token')) {
        const val = localStorage.getItem(key)
        if (val && val.includes('access_token')) return true
      }
    }
    return false
  } catch {
    return false
  }
}

export function setCachedSessionSync(hasSession: boolean): void {
  try {
    if (hasSession) {
      localStorage.setItem(SESSION_STORAGE_KEY, 'true')
    } else {
      localStorage.removeItem(SESSION_STORAGE_KEY)
      localStorage.removeItem(LEDGER_STORAGE_KEY)
    }
  } catch { /* ignore */ }
}

export async function readLedger() {
  const fromDb = await (await dbPromise).get('ledger', 'current')
  if (fromDb) {
    writeCachedLedgerSync(fromDb)
    return fromDb
  }
  return readCachedLedgerSync()
}

export async function writeLedger(ledger: Ledger) {
  writeCachedLedgerSync(ledger)
  await (await dbPromise).put('ledger', ledger, 'current')
}
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
