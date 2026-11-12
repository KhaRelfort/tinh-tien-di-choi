// NOTE(VI): Lý do: Bổ sung avatarUrl và email cho Member, isOwner / currentUserEmail / currentMemberId cho Ledger, và kiểu LedgerListItem để quản lý nhiều sổ
// Trước: Member chỉ có avatarUrl; Ledger chỉ có 1 sổ đơn lẻ gắn theo auth.uid()
// Sau: Member có email để liên kết tài khoản bạn bè; Ledger có cờ isOwner; bổ sung LedgerListItem để chuyển đổi giữa các sổ
// Test: Kiểm tra kiểu dữ liệu Member và Ledger
export type Member = { id: string; name: string; sortOrder: number; active: boolean; avatarUrl?: string | null; email?: string | null }
// NOTE(VI): Lý do: Hỗ trợ splitMode gồm 'equal', 'custom' (chia theo số tiền) và 'percent' (chia theo %)
// Trước: splitMode chỉ là 'equal' | 'custom'
// Sau: splitMode là 'equal' | 'custom' | 'percent'
// Test: Tạo khoản chi mới chia theo % và chia theo số tiền, kiểm tra lưu đúng mode
export type Split = { memberId: string; amount: number }
export type Expense = {
  id: string; title: string; amount: number; payerId: string; date: string; note: string;
  category: string; splitMode: 'equal' | 'custom' | 'percent'; splits: Split[]; periodId: string | null; updatedAt: string
  createdAt?: string
}
export type Settlement = {
  id: string; fromMemberId: string; toMemberId: string; amount: number; date: string; note: string; periodId: string | null; updatedAt: string
}
export type SettlementPeriod = { id: string; startDate: string; endDate: string | null; status: 'open' | 'pending' | 'settled'; settledAt: string | null }
export type Ledger = {
  id: string; name: string; ownerAvatarUrl?: string | null;
  members: Member[]; expenses: Expense[]; settlements: Settlement[]; periods: SettlementPeriod[];
  isOwner?: boolean; currentUserEmail?: string; currentMemberId?: string | null
}
export type LedgerListItem = {
  id: string; name: string; isOwner: boolean; ownerEmail?: string;
  linkedMemberName?: string | null; linkedMemberId?: string | null; createdAt?: string
  expenseCount?: number
}
export type Operation =
  | { opId: string; kind: 'expense_upsert'; record: Expense; expectedUpdatedAt: string | null; groupId?: string }
  | { opId: string; kind: 'expense_delete'; recordId: string; expectedUpdatedAt: string; groupId?: string }
  | { opId: string; kind: 'settlement_upsert'; record: Settlement; groupId?: string }
  | { opId: string; kind: 'settlement_delete'; recordId: string; groupId?: string }
  | { opId: string; kind: 'members_update'; groupName: string; members: Member[]; ownerAvatarUrl?: string | null; groupId?: string }
  | { opId: string; kind: 'period_close'; periodId: string; endDate: string; nextPeriod: SettlementPeriod; groupId?: string }

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

// NOTE(VI): Lý do: Bóc tách nợ cũ và nợ mới của thành viên theo các kịch bản thực tế khi chia tiền qua nhiều kỳ:
// 1. Cả kỳ cũ và kỳ này đều nợ -> Kỳ cũ còn X, kỳ này Y
// 2. Kỳ cũ được nhận (+), kỳ này nợ (-) nhiều hơn -> Kỳ này Y - Đã trừ X kỳ trước
// 3. Kỳ cũ nợ (-), kỳ này chi tiêu được bù bớt (+) nhưng vẫn còn nợ -> Kỳ cũ còn X - Đã bù trừ Y kỳ này
// 4. Kỳ cũ nợ (-), kỳ này không phát sinh (0) -> Nợ tồn từ kỳ trước
// 5. Chỉ nợ kỳ này (pastBalance = 0) hoặc không nợ -> null (không thêm ghi chú)
// Test: Kiểm tra với các thành viên có nợ dồn kỳ cũ -> trả về đúng text bóc tách tương ứng
export type DebtBreakdown = {
  pastBalance: number
  currentBalance: number
  totalDebt: number
  note: string | null
}

// NOTE(VI): Lý do: Xác định linh hoạt "Kỳ này" để bóc tách nợ:
// - Nếu kỳ mở đang có hóa đơn -> "Kỳ này" là kỳ mở hiện tại, "Kỳ cũ" là các kỳ trước đó
// - Nếu kỳ mở chưa có hóa đơn (vừa bấm chốt sổ xong) -> "Kỳ này" là kỳ vừa mới chốt, "Kỳ cũ" là các kỳ trước kỳ vừa chốt
// Test: Vừa bấm chốt sổ xong xem gợi ý -> vẫn bóc tách đúng "kỳ cũ còn X, kỳ này Y" cho kỳ vừa chốt
export function getActiveCalculationPeriod(ledger: Ledger): SettlementPeriod | undefined {
  const openPeriod = ledger.periods.find((p) => p.status === 'open')
  const openHasExpenses = openPeriod
    ? ledger.expenses.some((e) => e.periodId === openPeriod.id || (!e.periodId && Boolean(openPeriod)))
    : false

  if (openPeriod && openHasExpenses) {
    return openPeriod
  }

  const allClosedPeriods = ledger.periods
    .filter((p) => p.status !== 'open')
    .sort((a, b) => {
      const dateA = a.endDate ?? a.settledAt ?? a.startDate
      const dateB = b.endDate ?? b.settledAt ?? b.startDate
      return dateB.localeCompare(dateA) || b.startDate.localeCompare(a.startDate)
    })

  if (allClosedPeriods.length > 0) {
    return allClosedPeriods[0]
  }

  return openPeriod
}

export function getMemberDebtBreakdown(ledger: Ledger, memberId: string): DebtBreakdown {
  const activePeriod = getActiveCalculationPeriod(ledger)
  const totalBalance = getBalances(ledger).get(memberId) ?? 0
  const currentBalance = activePeriod ? (getBalances(ledger, activePeriod.id).get(memberId) ?? 0) : totalBalance
  const pastBalance = totalBalance - currentBalance

  if (totalBalance >= 0) {
    return { pastBalance, currentBalance, totalDebt: 0, note: null }
  }

  const totalDebt = -totalBalance

  if (pastBalance === 0) {
    return { pastBalance, currentBalance, totalDebt, note: null }
  }

  // Kịch bản 1: Cả kỳ cũ và kỳ này đều nợ
  if (pastBalance < 0 && currentBalance < 0) {
    const pastDebt = -pastBalance
    const currentDebt = -currentBalance
    return {
      pastBalance,
      currentBalance,
      totalDebt,
      note: `Kỳ cũ còn ${money(pastDebt)}, kỳ này ${money(currentDebt)}`,
    }
  }

  // Kịch bản 2: Kỳ cũ được nhận (+), kỳ này nợ (-) nhiều hơn bù trừ qua
  if (pastBalance > 0 && currentBalance < 0) {
    const pastCredit = pastBalance
    const currentDebt = -currentBalance
    return {
      pastBalance,
      currentBalance,
      totalDebt,
      note: `Kỳ này ${money(currentDebt)} - Đã trừ ${money(pastCredit)} kỳ trước`,
    }
  }

  // Kịch bản 3: Kỳ cũ nợ (-), kỳ này chi tiêu bù bớt (+) nhưng vẫn còn nợ
  if (pastBalance < 0 && currentBalance > 0) {
    const pastDebt = -pastBalance
    const currentCredit = currentBalance
    return {
      pastBalance,
      currentBalance,
      totalDebt,
      note: `Kỳ cũ còn ${money(pastDebt)} - Đã bù trừ ${money(currentCredit)} kỳ này`,
    }
  }

  // Kịch bản 4: Kỳ cũ nợ (-), kỳ này không phát sinh (0)
  if (pastBalance < 0 && currentBalance === 0) {
    return {
      pastBalance,
      currentBalance,
      totalDebt,
      note: 'Nợ tồn từ kỳ trước',
    }
  }

  return { pastBalance, currentBalance, totalDebt, note: null }
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
  // NOTE(VI): Lý do: Lọc bỏ toàn bộ khoản chi mẫu demo (demo-1, demo-2, demo-3) và thanh toán mẫu nếu còn lưu trong cache/IndexedDB
  // Trước: Nếu trình duyệt đã cache các khoản chi demo thì vẫn hiển thị 856.000đ, 2.208.000đ và các khoản chi ảo
  // Sau: Tự động loại bỏ hoàn toàn các khoản chi có id bắt đầu bằng 'demo-' để hiển thị trống
  // Test: Mở app -> không còn các khoản chi mẫu (Vé tàu, Ăn tối, Cà phê), hiển thị trống 0đ
  const cleanedExpenses = (ledger.expenses || []).filter((e) => !e.id.startsWith('demo-'))
  const cleanedSettlements = (ledger.settlements || []).filter((s) => !s.id.startsWith('demo-'))
  const ledgerWithCleaned = { ...ledger, expenses: cleanedExpenses, settlements: cleanedSettlements }

  if (raw.periods?.length) {
    const updatedPeriods = raw.periods.map((period) => period.status === 'pending'
      ? { ...period, status: 'settled' as const, settledAt: period.endDate ?? period.settledAt ?? today() }
      : period)
    return {
      ...ledgerWithCleaned,
      periods: updatedPeriods,
      expenses: cleanedExpenses.map((expense) => ({ ...expense, periodId: expense.periodId ?? updatedPeriods[0].id })),
      settlements: cleanedSettlements.map((settlement) => ({ ...settlement, periodId: settlement.periodId ?? updatedPeriods[0].id })),
    }
  }

  const startDate = cleanedExpenses.map((expense) => expense.date).sort()[0] ?? today()
  // NOTE(VI): Lý do: Dùng makeId() (crypto.randomUUID()) thay vì 'legacy-period-...' để đảm bảo id luôn là UUID hợp lệ, không gây lỗi cú pháp UUID trong PostgreSQL khi sync lên Supabase.
  // Trước: const period: SettlementPeriod = { id: `legacy-period-${ledger.id}`, startDate, endDate: null, status: 'open', settledAt: null }
  // Sau: const period: SettlementPeriod = { id: makeId(), startDate, endDate: null, status: 'open', settledAt: null }
  // Test: Chốt kỳ hoặc sync kỳ lên Supabase không bị lỗi "invalid input syntax for type uuid"
  const period: SettlementPeriod = { id: makeId(), startDate, endDate: null, status: 'open', settledAt: null }
  return {
    ...ledgerWithCleaned,
    periods: [period],
    expenses: cleanedExpenses.map((expense) => ({ ...expense, periodId: expense.periodId ?? period.id })),
    settlements: cleanedSettlements.map((settlement) => ({ ...settlement, periodId: settlement.periodId ?? period.id })),
  }
}

export function makeId() { return crypto.randomUUID() }

// NOTE(VI): Lý do: Xóa bỏ toàn bộ dữ liệu mẫu (Vé tàu, Ăn tối, Cà phê...) theo yêu cầu người dùng
// Trước: makeDemoLedger tạo sẵn 3 khoản chi mẫu (Vé tàu 1.280.000đ, Ăn tối 680.000đ, Cà phê 248.000đ)
// Sau: makeDemoLedger trả về sổ trống hoàn toàn (expenses: [], settlements: []), hiển thị trống 0đ
// Test: Mở app khi chưa có dữ liệu hoặc chưa tải được từ máy chủ -> Hiển thị trống 0đ, không có khoản chi ảo
export function makeDemoLedger(): Ledger {
  const period: SettlementPeriod = { id: makeId(), startDate: today(), endDate: null, status: 'open', settledAt: null }
  const members: Member[] = [
    { id: 'member-linh', name: 'Linh', sortOrder: 0, active: true },
    { id: 'member-minh', name: 'Minh', sortOrder: 1, active: true },
    { id: 'member-anh', name: 'Anh', sortOrder: 2, active: true },
    { id: 'member-huy', name: 'Huy', sortOrder: 3, active: true },
  ]
  return { id: 'local-trip-ledger', name: 'Sổ chi tiêu', members, periods: [period], expenses: [], settlements: [] }
}
