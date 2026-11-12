import { createClient } from '@supabase/supabase-js'
import type { Ledger, LedgerListItem, Operation } from '../domain'

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

// NOTE(VI): Lý do: Bổ sung groupId để tải sổ chi tiêu cụ thể (sổ của tôi hoặc sổ được mời) và fallback lấy từ localStorage
// Trước: fetchCloudLedger() không nhận tham số, chỉ tải sổ của owner_user_id = auth.uid()
// Sau: fetchCloudLedger(groupId?: string) truyền p_group_id lên RPC; nếu không truyền sẽ lấy từ localStorage (nếu có)
// Test: Gọi fetchCloudLedger() với hoặc không có groupId -> Luôn giữ đúng sổ người dùng đang xem
export async function fetchCloudLedger(groupId?: string): Promise<Ledger> {
  if (!supabase) throw new Error('Chưa cấu hình Supabase.')
  let target = groupId
  if (!target && typeof window !== 'undefined') {
    try { target = localStorage.getItem('chia-tien-active-ledger-id') || undefined } catch {}
  }
  const params = target ? { p_group_id: target } : {}
  const { data, error } = await supabase.rpc('get_ledger_snapshot', params)
  if (error) throw formatSupabaseError(error, 'Không thể tải sổ từ đám mây.')
  return data as Ledger
}

// NOTE(VI): Lý do: Lấy danh sách tất cả các sổ user có quyền truy cập (sổ tự tạo + sổ được mời)
// Trước: Không có hàm này
// Sau: Trả về mảng LedgerListItem gồm id, name, isOwner, ownerEmail, linkedMemberName
// Test: Gọi fetchUserLedgers() -> Trả về danh sách sổ đầy đủ
export async function fetchUserLedgers(): Promise<LedgerListItem[]> {
  if (!supabase) return []
  const { data, error } = await supabase.rpc('get_user_ledgers')
  if (error) {
    console.warn('Lỗi lấy danh sách sổ hoặc RPC chưa cập nhật:', error)
    return []
  }
  return (data ?? []) as LedgerListItem[]
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

// NOTE(VI): Lý do: Bỏ cơ chế fallback tự động sang 'custom' theo yêu cầu người dùng vì Supabase đã được nâng cấp cho phép lưu trực tiếp splitMode 'percent'
// Trước: Có đoạn kiểm tra và retry với 'custom' nếu dính lỗi constraint expenses_split_mode_check
// Sau: Gửi trực tiếp operation lên máy chủ
// Test: Tạo khoản chi chia theo % -> lưu trực tiếp splitMode = 'percent' lên Supabase
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
