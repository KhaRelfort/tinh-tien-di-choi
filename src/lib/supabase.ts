import { createClient } from '@supabase/supabase-js'
import type { Ledger, Operation } from '../domain'

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
const publishableKey = (import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY || import.meta.env.VITE_SUPABASE_ANON_KEY) as string | undefined
export const isCloudConfigured = Boolean(url && publishableKey)
export const supabase = isCloudConfigured ? createClient(url!, publishableKey!) : null

function formatSupabaseError(error: any, fallbackMessage: string): Error {
  if (!error) return new Error(fallbackMessage)
  if (error instanceof Error) return error
  const message = error.message || error.details || error.hint || (error.code ? `Lỗi Postgres (${error.code})` : fallbackMessage)
  return new Error(message)
}

export async function fetchCloudLedger(): Promise<Ledger> {
  if (!supabase) throw new Error('Chưa cấu hình Supabase.')
  const { data, error } = await supabase.rpc('get_ledger_snapshot')
  if (error) throw formatSupabaseError(error, 'Không thể tải sổ từ đám mây.')
  return data as Ledger
}

export async function fetchMonthlyExpenseTotals(): Promise<Record<string, number>> {
  if (!supabase) return {}
  const { data, error } = await supabase
    .from('monthly_expense_totals')
    .select('month_start, total_amount_vnd')
    .order('month_start', { ascending: true })
  if (error) throw formatSupabaseError(error, 'Không thể tải thống kê chi tiêu hàng tháng.')
  return Object.fromEntries((data ?? []).map((row) => [row.month_start.slice(0, 7), Number(row.total_amount_vnd)]))
}

export async function initializeCloudLedger(name: string, memberNames: string[]) {
  if (!supabase) throw new Error('Chưa cấu hình Supabase.')
  const { error } = await supabase.rpc('initialize_ledger', { p_name: name, p_member_names: memberNames })
  if (error) throw formatSupabaseError(error, 'Không thể tạo sổ mới trên máy chủ.')
  return fetchCloudLedger()
}

export async function syncOperation(operation: Operation) {
  if (!supabase) throw new Error('Chưa cấu hình Supabase.')
  const { error } = await supabase.rpc('apply_sync_operation', {
    p_op_id: operation.opId,
    p_operation: operation,
  })
  if (error) throw formatSupabaseError(error, 'Lỗi đồng bộ Supabase.')
}

export async function signIn(email: string, password: string) {
  if (!supabase) throw new Error('Chưa cấu hình Supabase.')
  const { error } = await supabase.auth.signInWithPassword({ email, password })
  if (error) throw formatSupabaseError(error, 'Không thể đăng nhập.')
}
export async function signUp(email: string, password: string) {
  if (!supabase) throw new Error('Chưa cấu hình Supabase.')
  const { error } = await supabase.auth.signUp({ email, password })
  if (error) throw formatSupabaseError(error, 'Không thể tạo tài khoản.')
}
export async function signOut() { if (supabase) await supabase.auth.signOut() }
