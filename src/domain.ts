// NOTE(VI): Lý do: Bổ sung avatarUrl cho Member, ownerAvatarUrl cho Ledger và Operation members_update
// Trước: Chỉ có tên, không lưu ảnh đại diện
// Sau: Hỗ trợ lưu trữ avatar dạng URL hoặc Data URL
// Test: Kiểm tra kiểu dữ liệu Member và Ledger có trường avatarUrl / ownerAvatarUrl
export type Member = { id: string; name: string; sortOrder: number; active: boolean; avatarUrl?: string | null }
export type Split = { memberId: string; amount: number }
export type Expense = {
  id: string; title: string; amount: number; payerId: string; date: string; note: string;
  category: string; splitMode: 'equal' | 'custom'; splits: Split[]; periodId: string | null; updatedAt: string
}
export type Settlement = {
  id: string; fromMemberId: string; toMemberId: string; amount: number; date: string; note: string; periodId: string | null; updatedAt: string
}
export type SettlementPeriod = { id: string; startDate: string; endDate: string | null; status: 'open' | 'pending' | 'settled'; settledAt: string | null }
export type Ledger = { id: string; name: string; ownerAvatarUrl?: string | null; members: Member[]; expenses: Expense[]; settlements: Settlement[]; periods: SettlementPeriod[] }
export type Operation =
  | { opId: string; kind: 'expense_upsert'; record: Expense; expectedUpdatedAt: string | null }
  | { opId: string; kind: 'expense_delete'; recordId: string; expectedUpdatedAt: string }
  | { opId: string; kind: 'settlement_upsert'; record: Settlement }
  | { opId: string; kind: 'settlement_delete'; recordId: string }
  | { opId: string; kind: 'members_update'; groupName: string; members: Member[]; ownerAvatarUrl?: string | null }
  | { opId: string; kind: 'period_close'; periodId: string; endDate: string; nextPeriod: SettlementPeriod }

export const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' }).format(new Date())
export const money = (value: number) => `${new Intl.NumberFormat('vi-VN').format(value)} ₫`
export const memberColor = (index: number) => ['#257b5c', '#e6a448', '#6c78b5', '#d47762'][index % 4]

export function equalSplits(total: number, memberIds: string[]): Split[] {
  if (!memberIds.length) return []
  const each = Math.floor(total / memberIds.length)
  const remainder = total % memberIds.length
  return memberIds.map((memberId, index) => ({ memberId, amount: each + (index < remainder ? 1 : 0) }))
}

export function getBalances(ledger: Ledger, periodId?: string) {
  const balances = new Map(ledger.members.map((member) => [member.id, 0]))
  for (const expense of ledger.expenses.filter((item) => periodId === undefined || item.periodId === periodId)) {
    balances.set(expense.payerId, (balances.get(expense.payerId) ?? 0) + expense.amount)
    for (const split of expense.splits) balances.set(split.memberId, (balances.get(split.memberId) ?? 0) - split.amount)
  }
  for (const settlement of ledger.settlements.filter((item) => periodId === undefined || item.periodId === periodId)) {
    balances.set(settlement.fromMemberId, (balances.get(settlement.fromMemberId) ?? 0) + settlement.amount)
    balances.set(settlement.toMemberId, (balances.get(settlement.toMemberId) ?? 0) - settlement.amount)
  }
  return balances
}

export function suggestSettlements(ledger: Ledger, periodId?: string) {
  const balances = getBalances(ledger, periodId)
  const creditors = ledger.members.map((member) => ({ memberId: member.id, amount: balances.get(member.id) ?? 0 })).filter((x) => x.amount > 0).sort((a, b) => b.amount - a.amount)
  const debtors = ledger.members.map((member) => ({ memberId: member.id, amount: -(balances.get(member.id) ?? 0) })).filter((x) => x.amount > 0).sort((a, b) => b.amount - a.amount)
  const suggestions: { fromMemberId: string; toMemberId: string; amount: number }[] = []
  let d = 0; let c = 0
  while (d < debtors.length && c < creditors.length) {
    const amount = Math.min(debtors[d].amount, creditors[c].amount)
    suggestions.push({ fromMemberId: debtors[d].memberId, toMemberId: creditors[c].memberId, amount })
    debtors[d].amount -= amount; creditors[c].amount -= amount
    if (debtors[d].amount === 0) d++
    if (creditors[c].amount === 0) c++
  }
  return suggestions
}

export function isPeriodBalanced(ledger: Ledger, periodId: string) {
  return [...getBalances(ledger, periodId).values()].every((amount) => amount === 0)
}

export function isLedgerBalanced(ledger: Ledger) {
  return [...getBalances(ledger).values()].every((amount) => amount === 0)
}

export function markClosedPeriodsSettled(ledger: Ledger): Ledger {
  return {
    ...ledger,
    periods: ledger.periods.map((period) => period.status === 'pending'
      ? { ...period, status: 'settled', settledAt: period.endDate ?? period.settledAt ?? today() }
      : period),
  }
}

export function getUnpaidTotal(ledger: Ledger) {
  return [...getBalances(ledger).values()].reduce((sum, value) => sum + (value < 0 ? -value : 0), 0)
}

export function normalizeLedger(ledger: Ledger): Ledger {
  const raw = ledger as Ledger & { periods?: SettlementPeriod[] }
  if (raw.periods?.length) return { ...ledger, periods: raw.periods.map((period) => period.status === 'pending'
    ? { ...period, status: 'settled', settledAt: period.endDate ?? period.settledAt ?? today() }
    : period) }
  const startDate = ledger.expenses.map((expense) => expense.date).sort()[0] ?? today()
  // NOTE(VI): Lý do: Dùng makeId() (crypto.randomUUID()) thay vì 'legacy-period-...' để đảm bảo id luôn là UUID hợp lệ, không gây lỗi cú pháp UUID trong PostgreSQL khi sync lên Supabase.
  // Trước: const period: SettlementPeriod = { id: `legacy-period-${ledger.id}`, startDate, endDate: null, status: 'open', settledAt: null }
  // Sau: const period: SettlementPeriod = { id: makeId(), startDate, endDate: null, status: 'open', settledAt: null }
  // Test: Chốt kỳ hoặc sync kỳ lên Supabase không bị lỗi "invalid input syntax for type uuid"
  const period: SettlementPeriod = { id: makeId(), startDate, endDate: null, status: 'open', settledAt: null }
  return {
    ...ledger,
    periods: [period],
    expenses: ledger.expenses.map((expense) => ({ ...expense, periodId: expense.periodId ?? period.id })),
    settlements: ledger.settlements.map((settlement) => ({ ...settlement, periodId: settlement.periodId ?? period.id })),
  }
}

export function makeId() { return crypto.randomUUID() }

export function makeDemoLedger(): Ledger {
  const period: SettlementPeriod = { id: 'local-period-1', startDate: today(), endDate: null, status: 'open', settledAt: null }
  const members: Member[] = [
    { id: 'member-linh', name: 'Linh', sortOrder: 0, active: true },
    { id: 'member-minh', name: 'Minh', sortOrder: 1, active: true },
    { id: 'member-anh', name: 'Anh', sortOrder: 2, active: true },
    { id: 'member-huy', name: 'Huy', sortOrder: 3, active: true },
  ]
  const expense = (id: string, title: string, amount: number, payerId: string, date: string, category: string): Expense => ({
    id, title, amount, payerId, date, category, note: '', splitMode: 'equal',
    splits: equalSplits(amount, members.map((m) => m.id)), periodId: period.id, updatedAt: new Date().toISOString(),
  })
  return { id: 'local-trip-ledger', name: 'Sổ chi tiêu nhóm mình', members, periods: [period], expenses: [
    expense('demo-1', 'Vé tàu đi Đà Lạt', 1280000, 'member-linh', today(), 'Di chuyển'),
    expense('demo-2', 'Ăn tối ngày đầu', 680000, 'member-minh', today(), 'Ăn uống'),
    expense('demo-3', 'Cà phê và bánh ngọt', 248000, 'member-anh', today(), 'Ăn uống'),
  ], settlements: [] }
}
