import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import {
  ArrowLeftRight, ArrowRight, ArrowUpRight, Check, ChevronDown, ChevronLeft, ChevronRight,
  Camera, CircleHelp, Cloud, CloudOff, Copy, DollarSign, Film, Filter, Info, LogOut, Pencil, Plane, Printer, UserRound,
  Plus, ReceiptText, RefreshCw, ShoppingCart, Sparkles, Utensils, UserRoundPlus, LockKeyhole,
  Wallet, X,
} from 'lucide-react'
import {
  equalSplits, getBalances, getUnpaidTotal, makeDemoLedger, makeId, memberColor, money, normalizeLedger,
  markClosedPeriodsSettled, suggestSettlements, today, type Expense, type Ledger, type Member, type Operation, type Settlement, type SettlementPeriod,
} from './domain'
import { clearQueue, queueOperation, readLedger, readQueue, removeOperation, replaceOperation, writeLedger } from './lib/localStore'
import {
  fetchCloudLedger, fetchMonthlyExpenseTotals, initializeCloudLedger, isCloudConfigured, signIn, signOut, signUp, supabase, syncOperation,
} from './lib/supabase'

type Page = 'expenses' | 'settlements'

// NOTE(VI): Lý do: Icon xe máy tối giản theo chuẩn phong cách nét vẽ 24x24 của Lucide
function Motorbike({ size = 17, ...props }: { size?: number } & React.SVGProps<SVGSVGElement>) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <circle cx="5" cy="16" r="3" />
      <circle cx="19" cy="16" r="3" />
      <path d="M7.5 14h5l4-4h-4" />
      <path d="M10 14l1.5-4.5" />
      <path d="M19 16l-3-8h-2" />
      <path d="M17.5 5h-1.5" />
    </svg>
  )
}

// NOTE(VI): Lý do: Đổi danh mục 'Dịch vụ và giải trí' lên vị trí thứ 2 (sau Ăn uống), đổi icon Khác thành $ (DollarSign) theo yêu cầu người dùng
// Trước: ['Ăn uống', 'Di chuyển', 'Mua sắm', 'Du lịch', 'Giải trí và dịch vụ', 'Khác'], Khác dùng icon Coffee
// Sau: ['Ăn uống', 'Dịch vụ và giải trí', 'Di chuyển', 'Mua sắm', 'Du lịch', 'Khác'], Khác dùng icon DollarSign ($)
// Test: Mở form thêm khoản chi -> Dropdown hiển thị 'Dịch vụ và giải trí' ở vị trí thứ 2; khoản chi 'Khác' hiển thị icon $
const categories = ['Ăn uống', 'Dịch vụ và giải trí', 'Di chuyển', 'Mua sắm', 'Du lịch', 'Khác']
const categoryIcon = (category: string) => {
  switch (category) {
    case 'Ăn uống':
      return Utensils
    case 'Dịch vụ và giải trí':
    case 'Giải trí và dịch vụ':
    case 'Vé tham quan':
      return Film
    case 'Di chuyển':
      return Motorbike
    case 'Mua sắm':
      return ShoppingCart
    case 'Du lịch':
    case 'Lưu trú':
      return Plane
    case 'Khác':
    default:
      return DollarSign
  }
}
const formatDate = (date: string) => new Intl.DateTimeFormat('vi-VN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Ho_Chi_Minh' }).format(new Date(`${date}T12:00:00`))
const sumExpenseMonths = (expenses: Expense[]) => expenses.reduce<Record<string, number>>((totals, expense) => {
  const month = expense.date.slice(0, 7)
  totals[month] = (totals[month] ?? 0) + expense.amount
  return totals
}, {})

function compressImageFile(file: File, maxSize = 128): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = reject
    reader.onload = () => {
      const img = new Image()
      img.onerror = reject
      img.onload = () => {
        const canvas = document.createElement('canvas')
        const minSide = Math.min(img.width, img.height)
        const sx = (img.width - minSide) / 2
        const sy = (img.height - minSide) / 2
        canvas.width = maxSize
        canvas.height = maxSize
        const ctx = canvas.getContext('2d')
        if (!ctx) { resolve(reader.result as string); return }
        ctx.drawImage(img, sx, sy, minSide, minSide, 0, 0, maxSize, maxSize)
        resolve(canvas.toDataURL('image/jpeg', 0.85))
      }
      img.src = reader.result as string
    }
    reader.readAsDataURL(file)
  })
}

function MemberAvatar({ member, index, className = '' }: { member?: Member; index?: number; className?: string }) {
  if (member?.avatarUrl) {
    return <span className={`person-avatar ${className}`} style={{ padding: 0, overflow: 'hidden' }}><img src={member.avatarUrl} alt={member.name} style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: '50%' }} /></span>
  }
  return <span className={`person-avatar ${className}`} style={{ background: memberColor(index ?? 0) }}>{(member?.name ?? '?')[0]}</span>
}

function AccountAvatar({ avatarUrl, className = '', size = 16 }: { avatarUrl?: string | null; className?: string; size?: number }) {
  if (avatarUrl) {
    return <span className={`account-avatar ${className}`} style={{ padding: 0, overflow: 'hidden' }}><img src={avatarUrl} alt="Avatar" style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: '50%' }} /></span>
  }
  return <span className={`account-avatar ${className}`}><UserRound size={size} /></span>
}
function applyPendingOperations(ledger: Ledger, operations: Operation[]): Ledger {
  return operations.reduce((current, operation) => {
    if (operation.kind === 'expense_upsert') return { ...current, expenses: [operation.record, ...current.expenses.filter((item) => item.id !== operation.record.id)] }
    if (operation.kind === 'expense_delete') return { ...current, expenses: current.expenses.filter((item) => item.id !== operation.recordId) }
    if (operation.kind === 'settlement_upsert') return markClosedPeriodsSettled({ ...current, settlements: [operation.record, ...current.settlements.filter((item) => item.id !== operation.record.id)] })
    if (operation.kind === 'settlement_delete') return { ...current, settlements: current.settlements.filter((item) => item.id !== operation.recordId) }
    if (operation.kind === 'members_update') return { ...current, name: operation.groupName, members: operation.members, ownerAvatarUrl: operation.ownerAvatarUrl ?? current.ownerAvatarUrl }
    const oldPeriod = current.periods.find((period) => period.id === operation.periodId)
    if (!oldPeriod) return current
    const nextPeriod = { ...oldPeriod, endDate: operation.endDate, status: 'settled' as const, settledAt: operation.endDate }
    let next: Ledger = {
      ...current,
      periods: [...current.periods.map((period) => period.id === oldPeriod.id ? nextPeriod : period), operation.nextPeriod],
      expenses: current.expenses.map((expense) => expense.periodId === oldPeriod.id && expense.date > operation.endDate ? { ...expense, periodId: operation.nextPeriod.id } : expense),
      settlements: current.settlements.map((settlement) => settlement.periodId === oldPeriod.id && settlement.date > operation.endDate ? { ...settlement, periodId: operation.nextPeriod.id } : settlement),
    }
    return next
  }, ledger)
}

export default function App() {
  const [ledger, setLedger] = useState<Ledger | null>(null)
  const [cachedMonthlyTotals, setCachedMonthlyTotals] = useState<Record<string, number> | null>(null)
  const computedMonthlyTotals = useMemo(() => ledger ? sumExpenseMonths(ledger.expenses) : {}, [ledger?.expenses])
  const [page, setPage] = useState<Page>('expenses')
  const [modal, setModal] = useState<'expense' | 'settlement' | 'confirm_settlement' | null>(null)
  const [pendingSettlement, setPendingSettlement] = useState<{ fromMemberId: string; toMemberId: string; amount: number; periodId: string } | null>(null)
  const [pendingSettlementDelete, setPendingSettlementDelete] = useState<Settlement | null>(null)
  // NOTE(VI): Lý do: Bổ sung popup xác nhận trước khi chốt kỳ để tránh bấm nhầm
  // Trước: Bấm Chốt kỳ lập tức chốt luôn không hỏi lại
  // Sau: Hiện popup xác nhận, người dùng bấm "Xác nhận chốt kỳ" mới tiến hành chốt
  // Test: Vào menu Quyết toán -> Bấm Chốt kỳ -> Hiện popup hỏi -> Bấm Quay lại thì đóng popup -> Bấm Xác nhận chốt kỳ thì thực hiện chốt
  const [showClosePeriodConfirm, setShowClosePeriodConfirm] = useState(false)
  const [settlementHistoryPage, setSettlementHistoryPage] = useState(1)
  const [showSettlementFilters, setShowSettlementFilters] = useState(false)
  const [showSettlementHistory, setShowSettlementHistory] = useState(false)
  const [settlementFilters, setSettlementFilters] = useState({ fromDate: '', toDate: '', memberId: '' })
  const [editing, setEditing] = useState<Expense | null>(null)
  // NOTE(VI): Lý do: State lưu khoản chi cần xem chi tiết khi bấm vào icon Info trên hóa đơn đã khóa
  // Trước: Không có modal xem chi tiết hóa đơn đã khóa
  // Sau: Bấm icon Info -> lưu viewingExpense để mở ExpenseDetailModal
  // Test: Bấm icon Info trên hóa đơn đã khóa -> modal xem chi tiết mở lên
  const [viewingExpense, setViewingExpense] = useState<Expense | null>(null)
  const [showExpenseFilters, setShowExpenseFilters] = useState(false)
  const [showBillModal, setShowBillModal] = useState(false)
  const [selectedChartMonth, setSelectedChartMonth] = useState<string | null>(null)
  const monthlyChartRef = useRef<HTMLDivElement>(null)
  const [showSavedStatus, setShowSavedStatus] = useState(false)
  const savedStatusTimerRef = useRef<number | null>(null)
  const [toastMessage, setToastMessage] = useState<string | null>(null)
  const toastTimerRef = useRef<number | null>(null)

  const showToast = useCallback((message: string) => {
    setToastMessage(message)
    if (toastTimerRef.current !== null) window.clearTimeout(toastTimerRef.current)
    toastTimerRef.current = window.setTimeout(() => {
      setToastMessage(null)
      toastTimerRef.current = null
    }, 2800)
  }, [])
  const [expenseFilters, setExpenseFilters] = useState({ fromDate: '', toDate: '', category: '', memberId: '', paymentStatus: '', periodId: '' })
  const [isOnline, setIsOnline] = useState(navigator.onLine)
  const [pendingCount, setPendingCount] = useState(0)
  const [syncing, setSyncing] = useState(false)
  const syncingRef = useRef(false)
  const [syncNotice, setSyncNotice] = useState('')
  const [conflictOperation, setConflictOperation] = useState<Operation | null>(null)
  const [sessionReady, setSessionReady] = useState(!isCloudConfigured)
  const [session, setSession] = useState<boolean>(!isCloudConfigured)
  const [userEmail, setUserEmail] = useState('')

  useEffect(() => {
    if (!selectedChartMonth) return
    const handleOutsideClick = (event: PointerEvent) => {
      if (!monthlyChartRef.current?.contains(event.target as Node)) setSelectedChartMonth(null)
    }
    document.addEventListener('pointerdown', handleOutsideClick)
    return () => document.removeEventListener('pointerdown', handleOutsideClick)
  }, [selectedChartMonth])
  const [showAccount, setShowAccount] = useState(false)
  const [needsSetup, setNeedsSetup] = useState(false)
  const [authMode, setAuthMode] = useState<'login' | 'signup'>('login')
  const [authError, setAuthError] = useState('')

  const refreshMonthlyTotals = useCallback(async () => {
    try { setCachedMonthlyTotals(await fetchMonthlyExpenseTotals()) }
    catch { setCachedMonthlyTotals(null) }
  }, [])

  const flashSavedStatus = useCallback(() => {
    setShowSavedStatus(true)
    if (savedStatusTimerRef.current !== null) window.clearTimeout(savedStatusTimerRef.current)
    savedStatusTimerRef.current = window.setTimeout(() => {
      setShowSavedStatus(false)
      savedStatusTimerRef.current = null
    }, 2200)
  }, [])

  useEffect(() => () => {
    if (savedStatusTimerRef.current !== null) window.clearTimeout(savedStatusTimerRef.current)
    if (toastTimerRef.current !== null) window.clearTimeout(toastTimerRef.current)
  }, [])

  const hydrate = useCallback(async (cloud = false) => {
    if (!cloud) setCachedMonthlyTotals(null)
    const saved = await readLedger()
    if (saved) { const normalized = normalizeLedger(saved); setLedger(normalized); await writeLedger(normalized) }
    else if (!cloud) {
      const demo = makeDemoLedger()
      setLedger(demo)
      await writeLedger(demo)
    }
    setPendingCount((await readQueue()).length)
    if (cloud && isOnline) {
      try {
        const remote = await fetchCloudLedger()
        if (!remote?.id) setNeedsSetup(true)
        else {
          // NOTE(VI): Lý do: Gộp hàng đợi thao tác chưa đồng bộ (queue) vào remote để tránh ghi đè làm mất khoản chi offline khi tải lại trang
          // Trước: const normalized = normalizeLedger(remote) ghi đè thẳng bản server, làm mất các khoản chi chưa kịp đẩy lên
          // Sau: applyPendingOperations(remote, queue) bảo toàn tất cả khoản chi đang chờ sync
          // Test: Thêm khoản chi offline hoặc chưa sync -> F5 trang web -> khoản chi vẫn hiển thị đầy đủ
          const queue = await readQueue()
          const merged = queue.length ? applyPendingOperations(remote, queue) : remote
          const normalized = normalizeLedger(merged)
          setLedger(normalized)
          await writeLedger(normalized)
          setNeedsSetup(false)
          await refreshMonthlyTotals()
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : ''
        if (message.toLowerCase().includes('no ledger') || message.toLowerCase().includes('not found')) setNeedsSetup(true)
        else setSyncNotice('Không tải được dữ liệu mới. Đang hiển thị bản lưu trên thiết bị.')
      }
    }
  }, [isOnline, refreshMonthlyTotals])

  useEffect(() => {
    if (!supabase) { void hydrate(false); return }
    void supabase.auth.getSession().then(({ data }) => {
      const authenticated = Boolean(data.session)
      setUserEmail(data.session?.user.email ?? '')
      setSession(authenticated); setSessionReady(true)
      if (authenticated) void hydrate(true)
    })
    const { data: listener } = supabase.auth.onAuthStateChange((_event, authSession) => {
      const authenticated = Boolean(authSession)
      setUserEmail(authSession?.user.email ?? '')
      setSession(authenticated); setSessionReady(true)
      if (authenticated) void hydrate(true)
      else { setLedger(null); setNeedsSetup(false); setShowAccount(false) }
    })
    return () => listener.subscription.unsubscribe()
  }, [hydrate])

  useEffect(() => {
    const online = () => setIsOnline(true)
    const offline = () => setIsOnline(false)
    window.addEventListener('online', online); window.addEventListener('offline', offline)
    return () => { window.removeEventListener('online', online); window.removeEventListener('offline', offline) }
  }, [])

  const processQueue = useCallback(async () => {
    if (!isCloudConfigured || !session || !isOnline || syncingRef.current || conflictOperation) return
    const queue = await readQueue()
    if (!queue.length) return
    syncingRef.current = true; setSyncing(true)
    let currentOperation: Operation | null = null
    try {
      for (const operation of queue) {
        currentOperation = operation
        try {
          await syncOperation(operation)
          await removeOperation(operation.opId)
        } catch (opErr: any) {
          const opMsg = String(opErr?.message || opErr || '').toLowerCase()
          // NOTE(VI): Lý do: Chỉ xóa thao tác chốt kỳ nếu kỳ đó thực sự đã được chốt từ trước trên server (period cannot be closed).
          // Tuyệt đối không được nuốt lỗi settlement_period_one_open_per_group vì nếu xóa thao tác thì fetchCloudLedger sẽ lấy dữ liệu cũ chưa chốt đè lên máy người dùng.
          // Trước: Xóa thao tác khi gặp settlement_period_one_open_per_group -> làm mất kỳ chốt cục bộ và bị server đè lại dữ liệu cũ ngày 4
          // Sau: Giữ nguyên thao tác, throw lỗi cụ thể để bảo vệ dữ liệu cục bộ không bị đè và hướng dẫn người dùng cập nhật SQL trên Supabase
          // Test: Bấm chốt kỳ khi Supabase chưa cập nhật SQL -> Dữ liệu kỳ mới và dấu ĐÃ THANH TOÁN được giữ nguyên, không bị giật lùi về ngày 4
          if (operation.kind === 'period_close' && opMsg.includes('period cannot be closed')) {
            await removeOperation(operation.opId)
            continue
          }
          if (opMsg.includes('settlement_period_one_open_per_group')) {
            throw new Error('Supabase cần cập nhật hàm chốt kỳ. Vui lòng mở Supabase SQL Editor và chạy file migration mới nhất')
          }
          throw opErr
        }
      }
      const fresh = await fetchCloudLedger()
      setLedger(fresh); await writeLedger(fresh)
      await refreshMonthlyTotals()
      setPendingCount(0); setSyncNotice(''); flashSavedStatus()
    } catch (error: any) {
      // NOTE(VI): Lý do: Lấy chính xác thông điệp lỗi từ Supabase/PostgreSQL thay vì gán cứng 'Không thể đồng bộ lúc này' khi error không phải instanceof Error
      // Trước: const message = error instanceof Error ? error.message : 'Không thể đồng bộ lúc này.'
      // Sau: Lấy message từ error object và bỏ dấu chấm thừa
      // Test: Khi có lỗi đồng bộ, banner hiển thị rõ lý do cụ thể
      const rawMsg = error instanceof Error ? error.message : (error?.message || error?.details || 'Không thể đồng bộ lúc này')
      const message = String(rawMsg).replace(/\.+$/, '')
      if (message.toLowerCase().includes('conflict') || message.toLowerCase().includes('changed')) {
        setConflictOperation(currentOperation)
        setSyncNotice('Sổ đã thay đổi trên thiết bị khác. Chọn cách xử lý trước khi tiếp tục đồng bộ.')
      } else {
        setSyncNotice(isOnline ? `Lỗi đồng bộ: ${message}. Dữ liệu vẫn được lưu trên thiết bị.` : 'Đang offline. Thay đổi vẫn được lưu trên thiết bị và sẽ đồng bộ khi có mạng.')
      }
    } finally { syncingRef.current = false; setSyncing(false); setPendingCount((await readQueue()).length) }
  }, [conflictOperation, flashSavedStatus, isOnline, refreshMonthlyTotals, session])

  useEffect(() => { void processQueue() }, [processQueue, pendingCount])

  async function resolveConflict(reapply: boolean) {
    if (!conflictOperation || !isOnline) return
    try {
      const remote = await fetchCloudLedger()
      let keptOperation = conflictOperation
      if (reapply && conflictOperation.kind === 'expense_upsert') {
        const serverVersion = remote.expenses.find((expense) => expense.id === conflictOperation.record.id)
        keptOperation = { ...conflictOperation, expectedUpdatedAt: serverVersion?.updatedAt ?? null }
        await replaceOperation(keptOperation)
      } else if (reapply && conflictOperation.kind === 'expense_delete') {
        const serverVersion = remote.expenses.find((expense) => expense.id === conflictOperation.recordId)
        if (serverVersion) {
          keptOperation = { ...conflictOperation, expectedUpdatedAt: serverVersion.updatedAt }
          await replaceOperation(keptOperation)
        } else await removeOperation(conflictOperation.opId)
      } else await removeOperation(conflictOperation.opId)
      const queue = await readQueue()
      const visible = applyPendingOperations(remote, queue)
      setLedger(visible); await writeLedger(visible)
      if (queue.length) setCachedMonthlyTotals(sumExpenseMonths(visible.expenses))
      else await refreshMonthlyTotals()
      setConflictOperation(null); setSyncNotice('')
      setPendingCount(queue.length)
      if (!queue.length) flashSavedStatus()
    } catch (error) { setSyncNotice(error instanceof Error ? error.message : 'Không tải được dữ liệu mới nhất.') }
  }

  // NOTE(VI): Lý do: Thêm hàm giải phóng hàng đợi bị kẹt khi thao tác không thể đồng bộ lên máy chủ, cho phép người dùng khôi phục trạng thái chuẩn từ cloud.
  // Trước: Nếu thao tác trong queue bị server từ chối, queue bị kẹt vĩnh viễn không thể sync tiếp
  // Sau: Cung cấp tùy chọn hủy hàng đợi kẹt và tải lại dữ liệu mới nhất từ máy chủ
  // Test: Bấm nút "Xóa hàng đợi" trên banner lỗi -> hàng đợi được dọn sạch, tải lại snapshot từ cloud
  async function discardPendingQueue() {
    if (!confirm('Bỏ qua các thay đổi chưa đồng bộ bị kẹt và tải lại dữ liệu mới nhất từ máy chủ?')) return
    await clearQueue()
    setPendingCount(0)
    setConflictOperation(null)
    setSyncNotice('')
    await hydrate(true)
  }

  async function commitOperation(operation: Operation, update: (current: Ledger) => Ledger) {
    if (!ledger) return
    const next = update(ledger)
    setLedger(next); await writeLedger(next)
    if (operation.kind === 'expense_upsert' || operation.kind === 'expense_delete') setCachedMonthlyTotals(sumExpenseMonths(next.expenses))
    if (isCloudConfigured) await queueOperation(operation)
    setPendingCount((await readQueue()).length)
    if (!isCloudConfigured) { setSyncNotice(''); flashSavedStatus() }
    else if (!isOnline) setSyncNotice('Đang offline. Thay đổi sẽ đồng bộ khi có mạng.')
  }

  async function submitAuth(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setAuthError('')
    const form = new FormData(event.currentTarget)
    const email = String(form.get('email') ?? '').trim(); const password = String(form.get('password') ?? '')
    try {
      if (authMode === 'signup') await signUp(email, password)
      else await signIn(email, password)
    } catch (error) { setAuthError(error instanceof Error ? error.message : 'Không thể đăng nhập.') }
  }

  async function createLedger(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const names = [1, 2, 3, 4].map((i) => String(form.get(`member${i}`) ?? '').trim())
    if (names.some((name) => !name)) return
    try {
      const created = normalizeLedger(await initializeCloudLedger(String(form.get('name') ?? 'Sổ chi tiêu nhóm mình'), names))
      setLedger(created); await writeLedger(created); setNeedsSetup(false)
      await refreshMonthlyTotals()
    } catch (error) { setAuthError(error instanceof Error ? error.message : 'Không tạo được sổ.') }
  }

  if (isCloudConfigured && !sessionReady) return <div className="loading-screen"><div className="brand-mark"><Wallet /></div><p>Đang mở sổ chi tiêu...</p></div>
  if (isCloudConfigured && !session) return <div className="auth-screen">
    <div className="auth-card"><div className="brand-mark"><Wallet /></div><span className="eyebrow">ĐI CHƠI, CHIA TIỀN</span>
      <h1>{authMode === 'login' ? 'Chào bạn trở lại' : 'Tạo tài khoản quản lý'}</h1><p>Đăng nhập để mở sổ chi tiêu của nhóm.</p>
      <form onSubmit={(event) => void submitAuth(event)} className="auth-form"><label>Email<input name="email" type="email" required placeholder="ban@email.com" /></label><label>Mật khẩu<input name="password" type="password" minLength={6} required placeholder="Ít nhất 6 ký tự" /></label>
        {authError && <div className="form-error">{authError}</div>}<button className="button primary full" type="submit">{authMode === 'login' ? 'Đăng nhập' : 'Tạo tài khoản'}</button>
      </form><button className="text-button" onClick={() => setAuthMode(authMode === 'login' ? 'signup' : 'login')}>{authMode === 'login' ? 'Chưa có tài khoản? Tạo mới' : 'Đã có tài khoản? Đăng nhập'}</button>
      {authMode === 'signup' && <p className="hint">Nếu email cần xác nhận, hãy mở liên kết trong hộp thư trước khi đăng nhập.</p>}
    </div></div>
  if (needsSetup && isCloudConfigured) return <div className="auth-screen"><div className="auth-card setup-card"><div className="brand-mark"><Sparkles /></div><span className="eyebrow">BẮT ĐẦU SỔ MỚI</span><h1>Nhóm mình có những ai?</h1><p>Đặt tên sổ và điền tên bốn thành viên. Bạn có thể đổi tên sau.</p>
    <form onSubmit={(event) => void createLedger(event)} className="auth-form"><label>Tên sổ<input name="name" defaultValue="Sổ chi tiêu nhóm mình" required /></label><div className="member-input-grid">{['Thành viên 1', 'Thành viên 2', 'Thành viên 3', 'Thành viên 4'].map((label, i) => <label key={label}>{label}<input name={`member${i + 1}`} placeholder={['Linh', 'Minh', 'Anh', 'Huy'][i]} required /></label>)}</div>{authError && <div className="form-error">{authError}</div>}<button className="button primary full">Tạo sổ chi tiêu</button></form>
  </div></div>
  if (!ledger) return <div className="loading-screen"><p>Đang chuẩn bị sổ chi tiêu...</p></div>

  const selectedPeriod = ledger.periods.find((period) => period.status === 'open') ?? [...ledger.periods].sort((a, b) => b.startDate.localeCompare(a.startDate))[0]
  const activeMembers = ledger.members.filter((member) => member.active)
  const balances = getBalances(ledger)
  const financiallyInvolved = new Set<string>()
  for (const expense of ledger.expenses) {
    financiallyInvolved.add(expense.payerId)
    for (const split of expense.splits) if (split.amount > 0) financiallyInvolved.add(split.memberId)
  }
  for (const settlement of ledger.settlements) {
    if (settlement.amount > 0) {
      financiallyInvolved.add(settlement.fromMemberId)
      financiallyInvolved.add(settlement.toMemberId)
    }
  }
  const calculationMembers = activeMembers.filter((member) => financiallyInvolved.has(member.id))
  const suggestions = suggestSettlements(ledger)
  const unpaidTotal = getUnpaidTotal(ledger)
  const periodSettlements = ledger.settlements
  const filteredSettlements = periodSettlements.filter((settlement) => {
    if (settlementFilters.fromDate && settlement.date < settlementFilters.fromDate) return false
    if (settlementFilters.toDate && settlement.date > settlementFilters.toDate) return false
    if (settlementFilters.memberId && settlement.fromMemberId !== settlementFilters.memberId && settlement.toMemberId !== settlementFilters.memberId) return false
    return true
  })
  // NOTE(VI): Lý do: Sắp xếp khoản chuyển tiền thêm sau/mới nhất lên trên đầu (so sánh ngày desc, cùng ngày so sánh thời gian tạo updatedAt desc)
  // Trước: const orderedSettlements = [...filteredSettlements].sort((a, b) => b.date.localeCompare(a.date))
  // Sau: const orderedSettlements = [...filteredSettlements].sort((a, b) => b.date.localeCompare(a.date) || (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '') || b.id.localeCompare(a.id))
  // Test: Ghi nhận trả tiền mới -> khoản vừa thêm hiển thị ngay dòng đầu tiên của danh sách
  const orderedSettlements = [...filteredSettlements].sort((a, b) => b.date.localeCompare(a.date) || (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '') || b.id.localeCompare(a.id))
  const settlementPageCount = Math.max(1, Math.ceil(orderedSettlements.length / 15))
  const safeSettlementPage = Math.min(settlementHistoryPage, settlementPageCount)
  const visibleSettlements = orderedSettlements.slice((safeSettlementPage - 1) * 15, safeSettlementPage * 15)
  const thisMonth = ledger.expenses.filter((expense) => expense.date.slice(0, 7) === today().slice(0, 7)).reduce((sum, expense) => sum + expense.amount, 0)
  const [currentYear, currentMonth] = today().split('-').map(Number)
  const monthlyExpenseTotals = Array.from({ length: 6 }, (_, index) => {
    const monthDate = new Date(Date.UTC(currentYear, currentMonth - 1 - (5 - index), 1))
    const year = monthDate.getUTCFullYear()
    const month = monthDate.getUTCMonth() + 1
    const key = `${year}-${String(month).padStart(2, '0')}`
    return {
      key,
      label: `T${month}`,
      title: new Intl.DateTimeFormat('vi-VN', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(monthDate),
      total: (cachedMonthlyTotals ?? computedMonthlyTotals)[key] ?? 0,
      isCurrent: index === 5,
    }
  })
  const maxMonthlyExpense = Math.max(0, ...monthlyExpenseTotals.map((item) => item.total))
  // NOTE(VI): Lý do: Bổ sung 5 kỳ chốt sổ gần nhất và kỳ hiện tại cho dropdown bộ lọc theo kỳ
  // Trước: Chưa có lọc theo kỳ chốt sổ
  // Sau: Lọc ra kỳ mở (hiện tại) và tối đa 5 kỳ đã chốt sổ gần nhất
  // Test: Bấm nút Lọc trong Khoản chi -> thấy dropdown "Kỳ chốt sổ" với Kỳ hiện tại và các kỳ chốt gần nhất
  const openPeriod = ledger.periods.find((period) => period.status === 'open')
  const closedPeriods = ledger.periods
    .filter((period) => period.status !== 'open')
    .sort((a, b) => {
      const dateA = a.endDate ?? a.settledAt ?? a.startDate
      const dateB = b.endDate ?? b.settledAt ?? b.startDate
      return dateB.localeCompare(dateA) || b.startDate.localeCompare(a.startDate)
    })
    .slice(0, 5)

  const filteredExpenses = ledger.expenses.filter((expense) => {
    if (expenseFilters.periodId) {
      if (expense.periodId !== expenseFilters.periodId) {
        const isOpen = openPeriod && expenseFilters.periodId === openPeriod.id
        if (!isOpen || expense.periodId) return false
      }
    }
    if (expenseFilters.fromDate && expense.date < expenseFilters.fromDate) return false
    if (expenseFilters.toDate && expense.date > expenseFilters.toDate) return false
    if (expenseFilters.category && expense.category !== expenseFilters.category) return false
    if (expenseFilters.memberId && expense.payerId !== expenseFilters.memberId && !expense.splits.some((split) => split.memberId === expenseFilters.memberId)) return false
    const isPaid = ledger.periods.find((period) => period.id === expense.periodId)?.status === 'settled'
    if (expenseFilters.paymentStatus === 'unpaid' && isPaid) return false
    if (expenseFilters.paymentStatus === 'paid' && !isPaid) return false
    return true
  })
  const activeFilterCount = Object.values(expenseFilters).filter(Boolean).length

  // NOTE(VI): Lý do: Đổi từ "Quyết toán" thành "Chốt sổ" trong menu điều hướng và toàn bộ UI app theo yêu cầu
  // Trước: label: 'Quyết toán'
  // Sau: label: 'Chốt sổ'
  // Test: Kiểm tra thanh điều hướng dưới mobile và menu hiển thị "Chốt sổ"
  const nav: { id: Page; label: string; icon: typeof Wallet }[] = [
    { id: 'expenses', label: 'Khoản chi', icon: ReceiptText },
    { id: 'settlements', label: 'Chốt sổ', icon: ArrowLeftRight },
  ]

  async function saveExpense(expense: Expense, previous?: Expense) {
    if (!ledger) return
    let openPeriod = ledger.periods.find((period) => period.status === 'open')
    let nextPeriods = ledger.periods
    if (!openPeriod) {
      openPeriod = { id: makeId(), startDate: today(), endDate: null, status: 'open', settledAt: null }
      nextPeriods = [...ledger.periods, openPeriod]
    }
    const periodId = expense.periodId ?? openPeriod.id
    const record = { ...expense, periodId, updatedAt: new Date().toISOString() }
    const operation: Operation = { opId: makeId(), kind: 'expense_upsert', record, expectedUpdatedAt: previous?.updatedAt ?? null }
    await commitOperation(operation, (current) => ({
      ...current,
      periods: nextPeriods,
      expenses: previous ? current.expenses.map((item) => item.id === record.id ? record : item) : [record, ...current.expenses],
    }))
    setModal(null); setEditing(null)
    showToast(previous ? 'Đã lưu thay đổi khoản chi' : 'Thêm khoản chi thành công')
  }

  async function deleteExpense(expense: Expense) {
    if (!confirm(`Xóa khoản “${expense.title}”?`)) return
    const operation: Operation = { opId: makeId(), kind: 'expense_delete', recordId: expense.id, expectedUpdatedAt: expense.updatedAt }
    await commitOperation(operation, (current) => ({ ...current, expenses: current.expenses.filter((item) => item.id !== expense.id) }))
  }

  async function recordSettlement(fromMemberId: string, toMemberId: string, amount: number, periodId: string) {
    const settlement: Settlement = { id: makeId(), fromMemberId, toMemberId, amount, date: today(), note: '', periodId, updatedAt: new Date().toISOString() }
    await commitOperation({ opId: makeId(), kind: 'settlement_upsert', record: settlement }, (current) =>
      markClosedPeriodsSettled({ ...current, settlements: [settlement, ...current.settlements] }))
    setSettlementHistoryPage(1)
    showToast('Ghi nhận chuyển tiền thành công')
  }

  function requestSettlementConfirmation(fromMemberId: string, toMemberId: string, amount: number, periodId: string) {
    setPendingSettlement({ fromMemberId, toMemberId, amount, periodId })
    setModal('confirm_settlement')
  }

  async function confirmPendingSettlement() {
    if (!pendingSettlement) return
    await recordSettlement(pendingSettlement.fromMemberId, pendingSettlement.toMemberId, pendingSettlement.amount, pendingSettlement.periodId)
    setPendingSettlement(null); setModal(null)
  }

  async function confirmDeleteSettlement() {
    if (!pendingSettlementDelete) return
    const settlementId = pendingSettlementDelete.id
    await commitOperation({ opId: makeId(), kind: 'settlement_delete', recordId: settlementId }, (current) => ({
      ...current,
      settlements: current.settlements.filter((settlement) => settlement.id !== settlementId),
    }))
    setPendingSettlementDelete(null)
    setSettlementHistoryPage(1)
  }

  // NOTE(VI): Lý do: Kỳ mới bắt đầu ngay hôm nay (endDate = today()) thay vì ngày mai (nextDate) để nếu trong ngày có chi tiêu tiếp theo thì tự động thuộc kỳ mới và có thể chốt tiếp nhiều lần trong cùng ngày
  // Trước: startDate: nextDate(endDate) -> làm kỳ mới bắt đầu từ ngày mai, nếu chi tiêu chiều/tối hôm nay sẽ bị lệch ngày và không chốt được lần 2 trong ngày
  // Sau: startDate: endDate (today())
  // Test: Chốt kỳ trưa nay -> thêm khoản chi chiều nay -> chốt tiếp tối nay thành công 100%
  async function closeCurrentPeriod() {
    if (!selectedPeriod || selectedPeriod.status !== 'open') return
    const endDate = today()
    const nextPeriod: SettlementPeriod = { id: makeId(), startDate: endDate, endDate: null, status: 'open', settledAt: null }
    const operation: Operation = { opId: makeId(), kind: 'period_close', periodId: selectedPeriod.id, endDate, nextPeriod }
    await commitOperation(operation, (current) => ({
      ...current,
      periods: [...current.periods.map((period) => period.id === selectedPeriod.id ? { ...period, endDate, status: 'settled' as const, settledAt: endDate } : period), nextPeriod],
      expenses: current.expenses.map((expense) => expense.periodId === selectedPeriod.id && expense.date > endDate ? { ...expense, periodId: nextPeriod.id } : expense),
      settlements: current.settlements.map((settlement) => settlement.periodId === selectedPeriod.id && settlement.date > endDate ? { ...settlement, periodId: nextPeriod.id } : settlement),
    }))
    setShowClosePeriodConfirm(false)
    showToast('Chốt sổ thành công')
  }



  async function updateMembers(members: Member[], groupName?: string, ownerAvatarUrl?: string | null) {
    if (!ledger) return
    const nextName = groupName !== undefined ? (groupName.trim() || ledger.name) : ledger.name; const nextOwnerAvatar = ownerAvatarUrl !== undefined ? ownerAvatarUrl : ledger.ownerAvatarUrl; const updated: Ledger = { ...ledger, name: nextName, members, ownerAvatarUrl: nextOwnerAvatar }
    setLedger(updated); await writeLedger(updated)
    if (isCloudConfigured) await queueOperation({ opId: makeId(), kind: 'members_update', groupName: updated.name, members, ownerAvatarUrl: updated.ownerAvatarUrl })
    setPendingCount((await readQueue()).length)
    if (isCloudConfigured && !isOnline) setSyncNotice('Tên đã lưu trên thiết bị. Sẽ đồng bộ khi có mạng.')
  }

  return <><div className="app-shell">
    <aside className="sidebar">
      <div className="brand"><div className="brand-mark"><Wallet /></div><div><strong>chia tiền</strong><span>đi chơi cùng nhau</span></div></div>
      <div className="trip-selector"><div className="trip-icon">✳</div><div className="trip-copy"><span>SỔ CHI TIÊU</span><strong>{ledger.name}</strong></div><ChevronDown size={15} /></div>
      <div className="nav-label">MENU</div><nav>{nav.map(({ id, label, icon: Icon }) => <button key={id} className={`nav-item ${page === id ? 'active' : ''}`} onClick={() => setPage(id)}><Icon size={18} strokeWidth={1.9} /><span>{label}</span></button>)}</nav>
      <div className="sidebar-bottom"><button className="help-card" onClick={() => setSyncNotice('Thêm khoản chi, chọn người trả và chia phần cho các thành viên. Số dư được cập nhật tự động.')}><span className="help-icon"><CircleHelp size={16} /></span><span><strong>Cần trợ giúp?</strong><small>Cách chia tiền hoạt động</small></span><ArrowUpRight size={14} /></button></div>
    </aside>

    <main className="main-area">
      <header className="topbar">
        {/* NOTE(VI): Lý do: Đổi tiêu đề app thành SỔ CHI TIÊU NHÓM, bỏ dòng phụ "Tổng chi tiêu nhóm", làm to chữ và căn giữa thẳng hàng với icon ví
            Trước: <strong>SỔ CHI TIÊU</strong><small>Tổng chi tiêu nhóm</small> (2 dòng, chữ nhỏ, bị lệch lên trên so với icon ví)
            Sau: <strong>SỔ CHI TIÊU NHÓM</strong> (1 dòng, chữ to hơn, căn giữa chuẩn với icon ví)
            Test: Xem góc trên bên trái header app -> Tiêu đề SỔ CHI TIÊU NHÓM to rõ, nằm chính giữa theo chiều dọc với icon ví */}
        <div className="app-wordmark">
          <span className="wordmark-icon"><Wallet size={18} /></span>
          <strong>SỔ CHI TIÊU NHÓM</strong>
        </div>
        <div className="top-actions">
          {(!isOnline || syncing || pendingCount > 0 || showSavedStatus) && <div className={`sync-status ${isOnline ? 'online' : 'offline'}`} title={!isOnline ? 'Đang offline' : syncing ? 'Đang đồng bộ' : pendingCount ? `${pendingCount} thay đổi chờ đồng bộ` : 'Đã đồng bộ'}>{isOnline ? <Cloud size={15} /> : <CloudOff size={15} />}<span>{!isOnline ? 'Offline' : syncing ? 'Đang lưu' : pendingCount ? `${pendingCount} chờ` : 'Đã lưu'}</span></div>}
          <button className="account-button" title="Tài khoản" aria-label="Mở thông tin tài khoản" aria-expanded={showAccount} onClick={() => setShowAccount(true)}><AccountAvatar avatarUrl={ledger.ownerAvatarUrl} size={16} /></button>
        </div>
      </header>
      <div className="content">
        {syncNotice && <div className={`sync-banner ${conflictOperation ? 'conflict-banner' : ''}`}><span>{syncNotice}</span>{conflictOperation && <div className="conflict-actions"><button onClick={() => void resolveConflict(false)}>Dùng bản mới</button><button onClick={() => void resolveConflict(true)}>Áp dụng thay đổi của tôi</button></div>}{!conflictOperation && pendingCount > 0 && <div className="sync-banner-actions"><button className="sync-retry" disabled={syncing || !isOnline} onClick={() => void processQueue()}>{syncing ? 'Đang thử...' : 'Thử đồng bộ lại'}</button><button className="sync-retry discard-queue-btn" disabled={syncing} title="Bỏ qua thao tác bị kẹt và tải lại từ máy chủ" onClick={() => void discardPendingQueue()}>Bỏ qua</button></div>}{!conflictOperation && <button aria-label="Đóng thông báo" onClick={() => setSyncNotice('')}><X size={15} /></button>}</div>}
        {!isCloudConfigured && <div className="local-banner"><CloudOff size={15} /><span>Đang dùng chế độ trên thiết bị. Kết nối Supabase để đồng bộ sổ giữa các máy.</span><button onClick={() => setSyncNotice('Sao chép .env.example thành .env.local, thêm URL và anon key trong Supabase, rồi chạy lại ứng dụng.')}>Cấu hình</button></div>}
        {/* NOTE(VI): Lý do: Bỏ text tiêu đề "Khoản chi" theo yêu cầu người dùng
            Trước: Có <div className="page-heading"><div><h1>Khoản chi</h1></div></div>
            Sau: Bỏ heading, vào thẳng các card tổng quan
            Test: Xem trang Khoản chi -> Tiêu đề to "Khoản chi" đã biến mất, giao diện thoáng và gọn */}
        {page === 'expenses' && <><section className="summary-grid expense-summary-grid">
            <article className="summary-card total-card"><div className="summary-top"><span>Tổng chi chưa thanh toán</span><span className="summary-icon green"><Wallet size={17} /></span></div><strong>{money(unpaidTotal)}</strong><div className="card-watermark">₫</div></article>
            <article className="summary-card"><div className="summary-top"><span>Chi tiêu tháng này</span></div><strong>{money(thisMonth)}</strong><div ref={monthlyChartRef} className="monthly-chart" aria-label="Chi tiêu theo tháng trong 6 tháng gần nhất"><div className="mini-bars">{monthlyExpenseTotals.map((item) => {
              const barHeight = maxMonthlyExpense ? item.total / maxMonthlyExpense * 92 : 0
              return <button key={item.key} type="button" className={`month-bar ${item.isCurrent ? 'current-month' : ''} ${item.total === 0 ? 'no-data' : ''} ${selectedChartMonth === item.key ? 'selected-month' : ''}`} title={`${item.title}: ${money(item.total)}`} aria-label={`${item.title}: ${money(item.total)}`} aria-pressed={selectedChartMonth === item.key} onClick={() => setSelectedChartMonth(item.key)}><i style={{ height: `${barHeight}%` }} />{selectedChartMonth === item.key && <><b style={{ bottom: `calc(${barHeight}% + 3px)` }}>{new Intl.NumberFormat('vi-VN', { maximumFractionDigits: 1 }).format(item.total / 1000)}k</b><small>{item.label}</small></>}</button>
            })}</div></div></article>
          </section>
          {/* NOTE(VI): Lý do: Bỏ text "Các khoản chi được ghi lại theo ngày", giữ nút In bill & Lọc cùng hàng không xuống dòng, căn thẳng hàng với tiêu đề
              Trước: Có p phụ đề; nút bị co rớt chữ Lọc xuống dòng; tiêu đề bọc trong div thừa gây lệch hàng
              Sau: Tiêu đề h2 trực tiếp trong panel-heading với align-items: center; nút có thẻ span và white-space: nowrap
              Test: Xem phần Lịch sử chi tiêu -> Tiêu đề gọn gàng, căn thẳng hàng ngang tuyệt đối với 2 nút In bill và Lọc */}
          <CurrentMoneyOverview members={calculationMembers} balances={balances} /><section className="panel full-panel">
            <div className="panel-heading"><h2>Lịch sử chi tiêu</h2><div className="expense-panel-actions"><button type="button" className="filter-button" onClick={() => setShowBillModal(true)}><Printer size={14} /><span>In bill</span></button><button type="button" className={`filter-button ${showExpenseFilters ? 'active' : ''}`} aria-expanded={showExpenseFilters} onClick={() => setShowExpenseFilters((open) => !open)}><Filter size={14} /><span>Lọc</span>{activeFilterCount > 0 && <span className="filter-badge">{activeFilterCount}</span>}</button></div></div>
            {showExpenseFilters && <div className="expense-filters"><div className="expense-filter-fields">
              <label style={{ gridColumn: 'span 2' }}>Kỳ chốt sổ
                <select value={expenseFilters.periodId} onChange={(event) => setExpenseFilters({ ...expenseFilters, periodId: event.target.value })}>
                  <option value="">Tất cả các kỳ</option>
                  {openPeriod && <option value={openPeriod.id}>Kỳ hiện tại (từ {formatDate(openPeriod.startDate)} đến nay)</option>}
                  {closedPeriods.map((period) => (
                    <option key={period.id} value={period.id}>
                      {period.endDate ? `Kỳ ${formatDate(period.startDate)} – ${formatDate(period.endDate)}` : `Kỳ từ ${formatDate(period.startDate)}`} (Đã chốt)
                    </option>
                  ))}
                </select>
              </label>
              <label>Từ ngày<input type="date" value={expenseFilters.fromDate} onChange={(event) => setExpenseFilters({ ...expenseFilters, fromDate: event.target.value })} /></label>
              <label>Đến ngày<input type="date" value={expenseFilters.toDate} onChange={(event) => setExpenseFilters({ ...expenseFilters, toDate: event.target.value })} /></label>
              <label>Danh mục<select value={expenseFilters.category} onChange={(event) => setExpenseFilters({ ...expenseFilters, category: event.target.value })}><option value="">Tất cả danh mục</option>{categories.map((category) => <option key={category} value={category}>{category}</option>)}</select></label>
              <label>Thành viên<select value={expenseFilters.memberId} onChange={(event) => setExpenseFilters({ ...expenseFilters, memberId: event.target.value })}><option value="">Tất cả thành viên</option>{ledger.members.map((member) => <option key={member.id} value={member.id}>{member.name}</option>)}</select></label>
              <label>Trạng thái<select value={expenseFilters.paymentStatus} onChange={(event) => setExpenseFilters({ ...expenseFilters, paymentStatus: event.target.value })}><option value="">Tất cả trạng thái</option><option value="unpaid">Chưa chốt sổ</option><option value="paid">Đã chốt sổ</option></select></label>
            </div><div className="filters-footer"><span>{filteredExpenses.length} khoản phù hợp</span><button disabled={activeFilterCount === 0} onClick={() => setExpenseFilters({ fromDate: '', toDate: '', category: '', memberId: '', paymentStatus: '', periodId: '' })}>Xóa bộ lọc</button></div></div>}
            {/* NOTE(VI): Lý do: Sắp xếp hóa đơn thêm sau đưa lên trên (ưu tiên ngày mới nhất desc, cùng ngày thì khoản nào thêm sau/cập nhật sau - updatedAt desc - sẽ xếp lên trên đầu).
                Trước: [...filteredExpenses].sort((a, b) => b.date.localeCompare(a.date))
                Sau: [...filteredExpenses].sort((a, b) => b.date.localeCompare(a.date) || (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '') || b.id.localeCompare(a.id))
                Test: Thêm khoản chi mới -> khoản chi vừa thêm hiển thị ngay dòng trên cùng của Lịch sử chi tiêu */}
            <ExpenseList key={JSON.stringify(expenseFilters)} expenses={[...filteredExpenses].sort((a, b) => b.date.localeCompare(a.date) || (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '') || b.id.localeCompare(a.id))} members={ledger.members} periods={ledger.periods} onEdit={(expense) => { setEditing(expense); setModal('expense') }} onDelete={(expense) => void deleteExpense(expense)} onView={(expense) => setViewingExpense(expense)} emptyText={activeFilterCount ? 'Không tìm thấy khoản chi phù hợp với bộ lọc.' : 'Chưa có khoản chi nào. Thêm khoản chi đầu tiên nhé.'} />
          </section></>}

        {/* NOTE(VI): Lý do: Bỏ text tiêu đề "Quyết toán" theo yêu cầu người dùng
            Trước: Có <div className="page-heading"><div><h1>Quyết toán</h1></div></div>
            Sau: Bỏ heading, vào thẳng thanh kỳ hiện tại và số dư
            Test: Xem trang Quyết toán -> Tiêu đề to "Quyết toán" đã biến mất, giao diện thoáng và gọn */}
        {page === 'settlements' && <>
          <section className="period-toolbar panel"><div className="period-current"><strong>Kỳ hiện tại</strong><span>Từ ngày <b>{selectedPeriod ? formatDate(selectedPeriod.startDate) : '—'}</b> đến nay</span></div>{selectedPeriod?.status === 'open' && <button className="button primary" onClick={() => setShowClosePeriodConfirm(true)}><LockKeyhole size={15} /> Chốt sổ</button>}</section>
        {/* NOTE(VI): Lý do: Bỏ text phụ đề và chữ Cần trả/Sẽ nhận ở Số dư hiện tại trang Quyết toán theo yêu cầu
            Trước: Có text "Tính tất cả các khoản chưa thanh toán..." và tag <small>Cần trả / Sẽ nhận</small>
            Sau: Bỏ hẳn <p> và <small>, chỉ hiển thị tên và số tiền gọn gàng
            Test: Vào tab Quyết toán -> Tiêu đề Số dư hiện tại gọn gàng, dòng thành viên chỉ hiển thị avatar, tên và số tiền */}
        <section className="settlement-layout"><div className="panel balance-panel"><div className="panel-heading"><div><h2>Số dư hiện tại</h2></div></div><div className="balance-list">{calculationMembers.length ? calculationMembers.map((member, index) => { const amount = balances.get(member.id) ?? 0; return <div className="balance-row" key={member.id}><MemberAvatar member={member} index={index} /><span className="person-info"><strong>{member.name}</strong></span><strong className={`balance-amount ${amount > 0 ? 'positive' : amount < 0 ? 'negative' : ''}`}>{amount > 0 ? '+' : ''}{money(amount)}</strong></div>}) : <div className="empty-state compact"><p>Chưa có thành viên phát sinh chi tiêu hoặc trả tiền.</p></div>}</div></div><SettlementSuggestionsPanel suggestions={suggestions} members={ledger.members} onRecord={(from, to, amount) => requestSettlementConfirmation(from, to, amount, ledger.periods.find((period) => period.status === 'open')?.id ?? '')} /></section>
          {/* NOTE(VI): Lý do: Ẩn bớt lịch sử trả tiền ở menu quyết toán cho gọn, bấm nút Xem/Thu gọn mới xổ xuống
              Trước: Lịch sử trả tiền luôn hiển thị đầy đủ làm trang bị dài
              Sau: Mặc định ẩn, có nút xổ xuống (ChevronDown) kèm số lượng lần trả tiền; bấm vào để bung ra hoặc thu gọn
              Test: Vào menu Quyết toán -> Kiểm tra phần Lịch sử trả tiền đang thu gọn -> bấm "Xem" thì xổ xuống danh sách -> bấm "Thu gọn" thì ẩn đi */}
          <section className="panel full-panel">
            <div
              className="panel-heading"
              style={{ cursor: 'pointer' }}
              onClick={() => setShowSettlementHistory((open) => !open)}
            >
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <h2>Lịch sử trả tiền</h2>
                  {filteredSettlements.length > 0 && (
                    <span className="filter-badge" title={`${filteredSettlements.length} khoản trả tiền`}>
                      {filteredSettlements.length}
                    </span>
                  )}
                </div>
                <p>Các lần thành viên đã chuyển tiền cho nhau</p>
              </div>
              <div className="expense-panel-actions" onClick={(event) => event.stopPropagation()}>
                {showSettlementHistory && (
                  <button
                    type="button"
                    className={`filter-button ${showSettlementFilters ? 'active' : ''}`}
                    aria-expanded={showSettlementFilters}
                    onClick={() => setShowSettlementFilters((open) => !open)}
                  >
                    <Filter size={14} /> Lọc
                  </button>
                )}
                <button
                  type="button"
                  className={`filter-button ${showSettlementHistory ? 'active' : ''}`}
                  aria-expanded={showSettlementHistory}
                  onClick={() => setShowSettlementHistory((open) => !open)}
                  title={showSettlementHistory ? 'Thu gọn lịch sử' : 'Xem lịch sử trả tiền'}
                >
                  <ChevronDown
                    size={14}
                    style={{
                      transform: showSettlementHistory ? 'rotate(180deg)' : 'none',
                      transition: 'transform 0.2s ease',
                    }}
                  />
                  <span>{showSettlementHistory ? 'Thu gọn' : 'Xem'}</span>
                </button>
              </div>
            </div>
            {showSettlementHistory && (
              <>
                {showSettlementFilters && (
                  <div className="expense-filters">
                    <div className="expense-filter-fields">
                      <label>
                        Từ ngày
                        <input
                          type="date"
                          value={settlementFilters.fromDate}
                          onChange={(event) => {
                            setSettlementFilters({ ...settlementFilters, fromDate: event.target.value })
                            setSettlementHistoryPage(1)
                          }}
                        />
                      </label>
                      <label>
                        Đến ngày
                        <input
                          type="date"
                          value={settlementFilters.toDate}
                          onChange={(event) => {
                            setSettlementFilters({ ...settlementFilters, toDate: event.target.value })
                            setSettlementHistoryPage(1)
                          }}
                        />
                      </label>
                      <label>
                        Thành viên
                        <select
                          value={settlementFilters.memberId}
                          onChange={(event) => {
                            setSettlementFilters({ ...settlementFilters, memberId: event.target.value })
                            setSettlementHistoryPage(1)
                          }}
                        >
                          <option value="">Tất cả thành viên</option>
                          {ledger.members.map((member) => (
                            <option key={member.id} value={member.id}>
                              {member.name}
                            </option>
                          ))}
                        </select>
                      </label>
                    </div>
                    <div className="filters-footer">
                      <span />
                      <button
                        disabled={!Object.values(settlementFilters).some(Boolean)}
                        onClick={() => {
                          setSettlementFilters({ fromDate: '', toDate: '', memberId: '' })
                          setSettlementHistoryPage(1)
                        }}
                      >
                        Xóa bộ lọc
                      </button>
                    </div>
                  </div>
                )}
                {filteredSettlements.length ? (
                  <>
                    <div className="settlement-history">
                      {visibleSettlements.map((settlement) => {
                        const from = ledger.members.find((member) => member.id === settlement.fromMemberId)
                        const to = ledger.members.find((member) => member.id === settlement.toMemberId)
                        return (
                          <div className="history-row" key={settlement.id}>
                            <button
                              type="button"
                              className="history-icon history-delete-button"
                              aria-label="Xóa khoản trả tiền"
                              title="Xóa khoản trả tiền"
                              onClick={() => setPendingSettlementDelete(settlement)}
                            >
                              <Check size={16} />
                            </button>
                            <div>
                              <strong>
                                {from?.name} đã trả cho {to?.name}
                              </strong>
                              <small>
                                {formatDate(settlement.date)}
                                {settlement.note && ` · ${settlement.note}`}
                              </small>
                            </div>
                            <strong>{money(settlement.amount)}</strong>
                          </div>
                        )
                      })}
                    </div>
                    <PaginationControls
                      page={safeSettlementPage}
                      pageCount={settlementPageCount}
                      total={filteredSettlements.length}
                      onPageChange={setSettlementHistoryPage}
                    />
                  </>
                ) : (
                  <div className="empty-state compact">
                    <p>
                      {periodSettlements.length
                        ? 'Không tìm thấy giao dịch phù hợp với bộ lọc.'
                        : 'Chưa có lần trả tiền nào.'}
                    </p>
                  </div>
                )}
              </>
            )}
          </section></>}

      </div>
    </main>

    {modal === 'expense' && <ExpenseModal members={activeMembers} initial={editing} minDate={ledger.periods.find((period) => period.id === (editing?.periodId ?? ledger.periods.find((item) => item.status === 'open')?.id))?.startDate} onClose={() => { setModal(null); setEditing(null) }} onSave={(expense) => void saveExpense(expense, editing ?? undefined)} />}
    {modal === 'settlement' && <SettlementModal members={activeMembers} suggestions={suggestions} onClose={() => setModal(null)} onSave={(from, to, amount, note) => void (async () => { const settlement: Settlement = { id: makeId(), fromMemberId: from, toMemberId: to, amount, date: today(), note, periodId: ledger.periods.find((period) => period.status === 'open')?.id ?? null, updatedAt: new Date().toISOString() }; await commitOperation({ opId: makeId(), kind: 'settlement_upsert', record: settlement }, (current) => markClosedPeriodsSettled({ ...current, settlements: [settlement, ...current.settlements] })); setSettlementHistoryPage(1); setModal(null); showToast('Ghi nhận chuyển tiền thành công') })()} />}
    {modal === 'confirm_settlement' && pendingSettlement && <ConfirmSettlementModal from={ledger.members.find((member) => member.id === pendingSettlement.fromMemberId)?.name ?? 'Thành viên'} to={ledger.members.find((member) => member.id === pendingSettlement.toMemberId)?.name ?? 'Thành viên'} amount={pendingSettlement.amount} onClose={() => { setPendingSettlement(null); setModal(null) }} onConfirm={confirmPendingSettlement} />}
    {pendingSettlementDelete && <ConfirmDeleteSettlementModal from={ledger.members.find((member) => member.id === pendingSettlementDelete.fromMemberId)?.name ?? 'Thành viên'} to={ledger.members.find((member) => member.id === pendingSettlementDelete.toMemberId)?.name ?? 'Thành viên'} amount={pendingSettlementDelete.amount} onClose={() => setPendingSettlementDelete(null)} onConfirm={confirmDeleteSettlement} />}
    {showClosePeriodConfirm && selectedPeriod && (
      <ConfirmClosePeriodModal
        startDate={selectedPeriod.startDate}
        endDate={today()}
        onClose={() => setShowClosePeriodConfirm(false)}
        onConfirm={closeCurrentPeriod}
      />
    )}
    {showBillModal && <BillModal groupName={ledger.name} expenses={[...filteredExpenses].sort((a, b) => a.date.localeCompare(b.date) || a.title.localeCompare(b.title))} members={ledger.members} onClose={() => setShowBillModal(false)} />}
    {viewingExpense && (
      <ExpenseDetailModal
        expense={viewingExpense}
        members={ledger.members}
        periods={ledger.periods}
        onClose={() => setViewingExpense(null)}
      />
    )}
    {showAccount && <AccountModal
      email={userEmail}
      cloudEnabled={isCloudConfigured}
      groupName={ledger.name}
      ownerAvatarUrl={ledger.ownerAvatarUrl}
      members={ledger.members}
      onClose={() => setShowAccount(false)}
      onAddMember={async (name) => {
        const newMember: Member = { id: makeId(), name, sortOrder: Math.max(-1, ...ledger.members.map((member) => member.sortOrder)) + 1, active: true }
        await updateMembers([...ledger.members, newMember], ledger.name)
        showToast('Thêm thành viên thành công')
      }}
      onRenameMember={async (memberId, newName) => {
        const updatedMembers = ledger.members.map((member) => member.id === memberId ? { ...member, name: newName } : member)
        await updateMembers(updatedMembers, ledger.name)
      }}
      onUpdateMemberAvatar={async (memberId, avatarUrl) => {
        const updatedMembers = ledger.members.map((member) => member.id === memberId ? { ...member, avatarUrl } : member)
        await updateMembers(updatedMembers, ledger.name)
      }}
      onUpdateOwnerAvatar={async (avatarUrl) => {
        await updateMembers(ledger.members, ledger.name, avatarUrl)
      }}
      onLogout={() => { setShowAccount(false); void signOut() }}
    />}
    <nav className="mobile-nav">{nav.map(({ id, label, icon: Icon }) => <button key={id} className={page === id ? 'active' : ''} onClick={() => setPage(id)}><Icon size={18} /><span>{label}</span></button>)}</nav>
  </div>
    {/* NOTE(VI): Lý do: Dùng chung một cấu trúc button và UI CSS cho cả 2 tab Khoản chi và Quyết toán, chỉ khác text để chuyển qua lại không bị lệch nút
        Trước: 2 button riêng biệt {page === 'expenses' && ...} {page === 'settlements' && ...}
        Sau: 1 button duy nhất dùng chung class floating-add-expense, chỉ thay đổi text và onClick
        Test: Bấm chuyển qua lại giữa menu Khoản chi và Quyết toán, nút đứng yên cố định ở góc phải, chỉ đổi chữ bên trong */}
    <button
      type="button"
      className="button primary floating-add-expense"
      aria-label={page === 'expenses' ? 'Thêm khoản chi' : 'Ghi nhận trả tiền'}
      title={page === 'expenses' ? 'Thêm khoản chi' : 'Ghi nhận trả tiền'}
      onClick={() => {
        if (page === 'expenses') {
          setEditing(null)
          setModal('expense')
        } else {
          setModal('settlement')
        }
      }}
    >
      <Plus size={18} />
      <span>{page === 'expenses' ? 'Thêm khoản chi' : 'Ghi nhận trả tiền'}</span>
    </button>
    {toastMessage && (
      <div className="toast-notification" role="status" aria-live="polite">
        <span className="toast-icon"><Check size={14} strokeWidth={2.8} /></span>
        <span>{toastMessage}</span>
      </div>
    )}</>
}

function PaginationControls({ page, pageCount, total, onPageChange }: { page: number; pageCount: number; total: number; onPageChange: (page: number) => void }) {
  if (pageCount <= 1) return null
  const first = (page - 1) * 15 + 1
  const last = Math.min(page * 15, total)
  return <div className="pagination-controls"><span>{first}?{last} / {total}</span><div><button disabled={page <= 1} aria-label="Trang tr??c" onClick={() => onPageChange(page - 1)}><ChevronLeft size={16} /></button><span>{page} / {pageCount}</span><button disabled={page >= pageCount} aria-label="Trang sau" onClick={() => onPageChange(page + 1)}><ChevronRight size={16} /></button></div></div>
}

function BillModal({ groupName, expenses, members, onClose }: { groupName: string; expenses: Expense[]; members: Member[]; onClose: () => void }) {
  const [copied, setCopied] = useState(false)
  const total = expenses.reduce((sum, expense) => sum + expense.amount, 0)
  const memberName = (id: string) => members.find((member) => member.id === id)?.name ?? 'Thành viên đã ngừng hoạt động'
  const dateGroups = expenses.reduce<{ date: string; expenses: Expense[] }[]>((groups, expense) => {
    const current = groups[groups.length - 1]
    if (current?.date === expense.date) current.expenses.push(expense)
    else groups.push({ date: expense.date, expenses: [expense] })
    return groups
  }, [])
  const splitPercentages = (expense: Expense) => expense.splits.filter((split) => split.amount > 0).map((split) => `${memberName(split.memberId)} ${new Intl.NumberFormat('vi-VN', { maximumFractionDigits: 2 }).format(split.amount / expense.amount * 100)}%`).join(', ')
  const billText = [
    `CHI TIẾT CHI TIÊU NHÓM ${groupName.toLocaleUpperCase('vi-VN')}`,
    `Ngày tính: ${formatDate(today())}`,
    `Tổng chi: ${money(total)}`,
    '',
    ...dateGroups.flatMap((group) => [
      formatDate(group.date),
      ...group.expenses.flatMap((expense) => {
        const index = expenses.indexOf(expense) + 1
        return [
          `${String(index).padStart(2, '0')}. ${expense.title} — ${money(expense.amount)}`,
          `Người trả: ${memberName(expense.payerId)}`,
          ...((expense.splitMode === 'custom' || expense.splitMode === 'percent') ? [`Tỷ lệ: ${splitPercentages(expense)}`] : []),
        ]
      }),
      '',
    ]),
  ].join('\n')

  async function copyAll() {
    try {
      await navigator.clipboard.writeText(billText)
      setCopied(true)
    } catch {
      const textArea = document.createElement('textarea')
      textArea.value = billText
      textArea.style.position = 'fixed'
      textArea.style.opacity = '0'
      document.body.appendChild(textArea)
      textArea.select()
      const success = document.execCommand('copy')
      textArea.remove()
      setCopied(success)
    }
    window.setTimeout(() => setCopied(false), 2200)
  }

  return <Modal centered wide className="bill-modal" eyebrow="BILL CHI TIÊU NHÓM" title="Chi tiết chi tiêu" subtitle="Tổng hợp các khoản chi." onClose={onClose}>
    <div className="bill-preview bill-printable"><div className="bill-document-heading"><h2>{groupName}</h2><p>Ngày tính: {formatDate(today())}</p><strong>{money(total)}</strong></div>
      {dateGroups.length ? <div className="bill-expense-list">{dateGroups.map((group) => <section className="bill-date-group" key={group.date}><h3>{formatDate(group.date)}</h3>{group.expenses.map((expense) => {
        const index = expenses.indexOf(expense) + 1
        return <article className="bill-expense" key={expense.id}><div className="bill-expense-title"><strong>{String(index).padStart(2, '0')}. {expense.title}</strong><b>{money(expense.amount)}</b></div><p>Người trả: {memberName(expense.payerId)}</p>{(expense.splitMode === 'custom' || expense.splitMode === 'percent') && <p>Tỷ lệ: {splitPercentages(expense)}</p>}</article>
      })}</section>)}</div> : <div className="empty-state compact"><p>Không có hóa đơn nào khớp bộ lọc.</p></div>}
      <pre className="bill-copy-text">{billText}</pre>
    </div>
    <div className="modal-actions bill-actions"><button type="button" className="button secondary" onClick={onClose}>Đóng</button><button type="button" className="button primary" onClick={() => void copyAll()}><Copy size={15} /> {copied ? 'Đã sao chép' : 'Copy toàn bộ'}</button></div>
  </Modal>
}

function ExpenseList({
  expenses,
  members,
  periods,
  onEdit,
  onDelete,
  onView,
  emptyText,
}: {
  expenses: Expense[]
  members: Member[]
  periods: SettlementPeriod[]
  onEdit: (expense: Expense) => void
  onDelete: (expense: Expense) => void
  onView: (expense: Expense) => void
  emptyText: string
}) {
  const [page, setPage] = useState(1)
  const pageCount = Math.max(1, Math.ceil(expenses.length / 15))
  const currentPage = Math.min(page, pageCount)
  const visibleExpenses = expenses.slice((currentPage - 1) * 15, currentPage * 15)
  useEffect(() => setPage(1), [expenses.length])
  if (!expenses.length) return <div className="empty-state"><div className="empty-icon"><ReceiptText size={20} /></div><p>{emptyText}</p></div>
  return <>
    <div className="expense-list">
      {visibleExpenses.map((expense) => {
        const payer = members.find((member) => member.id === expense.payerId)
        const Icon = categoryIcon(expense.category)
        const period = periods.find((item) => item.id === expense.periodId)
        const locked = period?.status !== 'open'
        return <div className={`expense-row ${locked ? 'expense-row-settled' : ''}`} key={expense.id}>
          <span className="expense-icon"><Icon size={17} /></span>
          <div className="expense-detail">
            <strong>{expense.title}</strong>
            <div className="expense-meta"><span>{formatDate(expense.date)} <i /> {payer?.name ?? 'Thành viên đã ngừng hoạt động'} đã trả</span>{period && period.status !== 'open' && <span className="paid-stamp"><strong style={{ color: '#c32026', fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "DM Sans", sans-serif', fontWeight: 500, letterSpacing: '0.4px' }}>ĐÃ CHỐT SỔ</strong></span>}</div>
            {period && period.status !== 'open' && <small className="settlement-date">Chốt sổ: {formatDate(period.endDate ?? period.settledAt ?? period.startDate)}</small>}
          </div>
          <span className="expense-split-count">{expense.splits.length} người</span>
          <strong className="expense-amount">{money(expense.amount)}</strong>
          {/* NOTE(VI): Lý do: Đổi icon sửa thành cây bút (Pencil), sửa lỗi font chữ hover s?a/x?a thành Sửa/Xóa tiếng Việt chuẩn, và thêm icon Info cạnh icon khóa cho hóa đơn đã khóa
              Trước: Icon Settings2, title s?a/x?a bị lỗi font, hóa đơn đã khóa chỉ có icon khóa LockKeyhole
              Sau: Icon Pencil, title Sửa/Xóa chuẩn UTF-8, thêm nút Info cạnh icon khóa để click xem chi tiết
              Test: Di chuột vào nút Sửa/Xóa -> hiện tooltip "Sửa", "Xóa"; hóa đơn đã khóa hiện icon Info cạnh khóa -> bấm vào hiện modal xem chi tiết */}
          <div className="row-actions">{locked
            ? <>
                <button type="button" aria-label="Xem chi tiết khoản chi" title="Xem chi tiết" onClick={() => onView(expense)}><Info size={15} /></button>
                <span title="Khoản chi thuộc kỳ đã chốt"><LockKeyhole size={15} /></span>
              </>
            : <>
                <button type="button" aria-label="Sửa khoản chi" title="Sửa" onClick={() => onEdit(expense)}><Pencil size={14} /></button>
                <button type="button" aria-label="Xóa khoản chi" title="Xóa" onClick={() => onDelete(expense)}><X size={15} /></button>
              </>}
          </div>
        </div>
      })}
    </div>
    <PaginationControls page={currentPage} pageCount={pageCount} total={expenses.length} onPageChange={setPage} />
  </>
}

function CurrentMoneyOverview({ members, balances }: { members: Member[]; balances: Map<string, number> }) {
  {/* NOTE(VI): Lý do: Bỏ text "Tự cập nhật theo tất cả khoản chi và lần trả." và bỏ text "Cần trả/Sẽ nhận" ở panel Số dư hiện tại trang Khoản chi
      Trước: Có thẻ <p> phụ đề và thẻ <small> ghi Cần trả / Sẽ nhận
      Sau: Bỏ thẻ <p> và <small>, chỉ giữ avatar, tên và số tiền (+/-)
      Test: Vào tab Khoản chi -> Panel Số dư hiện tại gọn sạch, không còn text phụ và nhãn cần trả/sẽ nhận */}
  return <section className="settlement-layout current-money-overview">
    <div className="panel balance-panel">
      <div className="panel-heading"><div><h2>Số dư hiện tại</h2></div></div>
      <div className="balance-list">{members.length ? members.map((member, index) => { const amount = balances.get(member.id) ?? 0; return <div className="balance-row" key={member.id}><MemberAvatar member={member} index={index} /><span className="person-info"><strong>{member.name}</strong></span><strong className={`balance-amount ${amount > 0 ? 'positive' : amount < 0 ? 'negative' : ''}`}>{amount > 0 ? '+' : ''}{money(amount)}</strong></div> }) : <div className="empty-state compact"><p>Chưa có thành viên phát sinh chi tiêu hoặc trả tiền.</p></div>}</div>
    </div>

  </section>
}

function SettlementSuggestionsPanel({ suggestions, members, onRecord, inline = false }: { suggestions: ReturnType<typeof suggestSettlements>; members: Member[]; onRecord: (fromId: string, toId: string, amount: number) => void; inline?: boolean }) {
  return <div className={`panel ${inline ? 'inline-suggestions-panel' : ''}`}>
    <div className="panel-heading"><div><h2>Gợi ý chuyển tiền</h2></div></div>
    {suggestions.length ? <div className="suggestion-list">{suggestions.map((suggestion) => {
      const from = members.find((member) => member.id === suggestion.fromMemberId)
      const to = members.find((member) => member.id === suggestion.toMemberId)
      if (!from || !to) return null
      return <div className="suggestion-row" key={`${from.id}-${to.id}`}>
        {/* NOTE(VI): Lý do: Đổi "chuyển cho" thành "trả" và đặt icon avatar người nhận ngay trước tên người nhận
            Trước: (Avatar from) Kha chuyển cho Thương (Avatar to ở cuối)
            Sau: (Avatar from) Kha trả (Avatar to) Thương
            Test: Vào tab Quyết toán -> Kiểm tra mục Gợi ý chuyển tiền: hiển thị icon người chuyển, tên, chữ "trả", icon người nhận, tên người nhận */}
        <div className="suggestion-people">
          <MemberAvatar member={from} index={members.indexOf(from)} />
          <span className="suggestion-name">{from.name}</span>
          <span className="suggestion-verb">trả</span>
          <MemberAvatar member={to} index={members.indexOf(to)} />
          <span className="suggestion-name">{to.name}</span>
        </div>
        <strong>{money(suggestion.amount)}</strong>
        <button className="button small-button" onClick={() => onRecord(from.id, to.id, suggestion.amount)}><Check size={14} /> Đã trả</button>
      </div>
    })}</div> : <div className="empty-state compact"><div className="empty-icon"><Check size={20} /></div><strong>Sổ đang cân bằng</strong><p>Không còn khoản nào cần chốt sổ.</p></div>}
  </div>
}

function ConfirmSettlementModal({ from, to, amount, onClose, onConfirm }: { from: string; to: string; amount: number; onClose: () => void; onConfirm: () => Promise<void> }) {
  const [saving, setSaving] = useState(false)
  async function confirm() { setSaving(true); try { await onConfirm() } finally { setSaving(false) } }
  return <Modal centered eyebrow={null} title="Xác nhận đã trả" subtitle="Chỉ xác nhận nếu khoản tiền đã được chuyển." onClose={onClose}>
    <div className="confirm-settlement-content"><div className="confirm-transfer"><span className="confirm-member">{from.slice(0, 1)}</span><ArrowRight size={17} /><span className="confirm-member receiver">{to.slice(0, 1)}</span></div><p><strong>{from}</strong> đã chuyển cho <strong>{to}</strong></p><b>{money(amount)}</b></div>
    <div className="modal-actions"><button type="button" className="button secondary" disabled={saving} onClick={onClose}>Chưa, quay lại</button><button type="button" className="button primary" disabled={saving} onClick={() => void confirm()}><Check size={16} /> {saving ? 'Đang lưu...' : 'Xác nhận đã trả'}</button></div>
  </Modal>
}

function ConfirmDeleteSettlementModal({ from, to, amount, onClose, onConfirm }: { from: string; to: string; amount: number; onClose: () => void; onConfirm: () => Promise<void> }) {
  const [deleting, setDeleting] = useState(false)
  async function confirm() { setDeleting(true); try { await onConfirm() } finally { setDeleting(false) } }
  return <Modal centered eyebrow={null} title="Xóa giao dịch trả tiền?" subtitle="Số dư và gợi ý chuyển tiền sẽ được tính lại." onClose={onClose}>
    <div className="confirm-delete-content"><strong>{from} đã trả cho {to}</strong><b>{money(amount)}</b></div>
    <div className="modal-actions"><button type="button" className="button secondary" disabled={deleting} onClick={onClose}>Giữ lại</button><button type="button" className="button danger" disabled={deleting} onClick={() => void confirm()}>{deleting ? 'Đang xóa...' : 'Xóa giao dịch'}</button></div>
  </Modal>
}

// NOTE(VI): Lý do: Rút gọn thông báo popup chốt kỳ ngắn gọn, rõ ràng theo yêu cầu người dùng
// Trước: Chữ dài và bị dồn cục "Kỳ chi tiêu sẽ được đóng lại và mở kỳ mới từ ngày tiếp theo..."
// Sau: Đúng format: Xác nhận chốt kỳ? / Kỳ chi tiêu sẽ được đóng lại và mở kỳ mới / Kỳ chốt này từ ngày x đến ngày y / Tất cả hóa đơn... / ĐÃ THANH TOÁN (xuống dòng riêng)
// Test: Bấm Chốt kỳ -> Kiểm tra thông báo gọn gàng, rõ ràng, con dấu ĐÃ THANH TOÁN nổi bật ở dòng riêng
function ConfirmClosePeriodModal({
  startDate,
  endDate,
  onClose,
  onConfirm,
}: {
  startDate: string
  endDate: string
  onClose: () => void
  onConfirm: () => Promise<void>
}) {
  const [closing, setClosing] = useState(false)
  async function confirm() {
    setClosing(true)
    try {
      await onConfirm()
    } finally {
      setClosing(false)
    }
  }
  return (
    <Modal
      centered
      eyebrow={null}
      title="Xác nhận chốt sổ?"
      subtitle="Kỳ chi tiêu sẽ được đóng lại và mở kỳ mới."
      onClose={onClose}
    >
      <div className="confirm-delete-content" style={{ gap: '10px', padding: '6px 0 16px' }}>
        <p style={{ margin: 0, color: '#323b34', fontSize: '13px', fontWeight: 600 }}>
          {startDate === endDate ? (
            <>Kỳ chốt này ngày <b>{formatDate(startDate)}</b></>
          ) : (
            <>Kỳ chốt này từ <b>{formatDate(startDate)}</b> đến <b>{formatDate(endDate)}</b></>
          )}
        </p>
        <div style={{ margin: '2px 0 0', color: '#687269', fontSize: '12.5px', lineHeight: 1.4 }}>
          Tất cả hóa đơn trong kỳ này sẽ được chuyển thành
        </div>
        <div className="paid-stamp" style={{ transform: 'none', margin: '2px 0 0', padding: '3px 10px' }}>
          <strong style={{ fontSize: '13px', letterSpacing: '0.5px', color: '#c32026', fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "DM Sans", sans-serif', fontWeight: 500 }}>ĐÃ CHỐT SỔ</strong>
        </div>
      </div>
      <div className="modal-actions">
        <button type="button" className="button secondary" disabled={closing} onClick={onClose}>
          Quay lại
        </button>
        <button type="button" className="button primary" disabled={closing} onClick={() => void confirm()}>
          <LockKeyhole size={15} /> {closing ? 'Đang chốt...' : 'Xác nhận chốt sổ'}
        </button>
      </div>
    </Modal>
  )
}

function AccountModal({
  email,
  cloudEnabled,
  groupName: _groupName,
  ownerAvatarUrl,
  members,
  onClose,
  onAddMember,
  onRenameMember,
  onUpdateMemberAvatar,
  onUpdateOwnerAvatar,
  onLogout,
}: {
  email: string
  cloudEnabled: boolean
  groupName: string
  ownerAvatarUrl?: string | null
  members: Member[]
  onClose: () => void
  onAddMember: (name: string) => Promise<void>
  onRenameMember: (memberId: string, newName: string) => Promise<void>
  onUpdateMemberAvatar: (memberId: string, avatarUrl: string | null) => Promise<void>
  onUpdateOwnerAvatar: (avatarUrl: string | null) => Promise<void>
  onLogout: () => void
}) {
  const activeMembers = members.filter((member) => member.active)
  const [addingMember, setAddingMember] = useState(false)
  const [newMemberName, setNewMemberName] = useState('')
  const [editingMember, setEditingMember] = useState<Member | null>(null)
  const [editMemberName, setEditMemberName] = useState('')
  const [savingMember, setSavingMember] = useState(false)
  const [memberError, setMemberError] = useState('')
  const [previewAvatar, setPreviewAvatar] = useState<{ url?: string | null; name: string; color?: string; initial?: string } | null>(null)
  const [checkingVersion, setCheckingVersion] = useState(false)
  const [updatingVersion, setUpdatingVersion] = useState(false)
  const [versionStatus, setVersionStatus] = useState<'idle' | 'checking' | 'latest' | 'has_update' | 'error'>('idle')
  const [latestVersion, setLatestVersion] = useState<string | null>(null)
  const ownerFileInputRef = useRef<HTMLInputElement>(null)
  const memberFileInputRef = useRef<HTMLInputElement>(null)
  const targetMemberIdRef = useRef<string | null>(null)

  // NOTE(VI): Lý do: Lấy phiên bản runtime từ window.__APP_VERSION__ (do version.js nạp vào) để ở localhost và prod luôn nhận đúng bản mới nhất mà không phụ thuộc vào việc restart process Vite
  // Trước: Dùng __APP_VERSION__ cứng của Vite define -> khi đổi version.js ở localhost mà chưa restart Vite dev thì số phiên bản bị lệch
  // Sau: Ưu tiên đọc window.__APP_VERSION__ runtime, fallback về __APP_VERSION__ compile-time
  // Test: Sửa version.js -> reload -> bản hiện tại cập nhật ngay lập tức
  const currentAppVersion = (typeof window !== 'undefined' && (window as any).__APP_VERSION__) || (typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '1.0.0')

  async function handleCheckVersion() {
    setCheckingVersion(true)
    setVersionStatus('checking')
    try {
      const res = await fetch(`/version.js?_t=${Date.now()}`, { cache: 'no-store' })
      if (!res.ok) throw new Error('Không thể kết nối đến server kiểm tra phiên bản.')
      const text = await res.text()
      const match = text.match(/APP_VERSION\s*=\s*['"]([^'"]+)['"]/)
      const latest = match?.[1]
      if (latest) {
        setLatestVersion(latest)
        if (latest !== currentAppVersion) {
          setVersionStatus('has_update')
        } else {
          setVersionStatus('latest')
        }
      } else {
        setVersionStatus('latest')
      }
    } catch {
      setVersionStatus('error')
    } finally {
      setCheckingVersion(false)
    }
  }

  // NOTE(VI): Lý do: Xóa sạch CacheStorage và unregister Service Worker cũ trước khi reload để ép browser tải mã nguồn mới nhất, tránh tình trạng iOS/Safari bị kẹt trong cache cũ
  // Trước: Chỉ gọi reg.update() rồi window.location.reload() -> Safari vẫn phục vụ bundle cũ từ CacheStorage
  // Sau: Xóa toàn bộ caches, unregister Service Worker, reload với query param _reload
  // Test: Bấm "Cập nhật ngay" -> App hiện trạng thái Đang cập nhật, xóa cache và tải lại ngay bản mới
  async function handleApplyUpdate() {
    setUpdatingVersion(true)
    try {
      if ('caches' in window) {
        const cacheKeys = await caches.keys()
        await Promise.all(cacheKeys.map((key) => caches.delete(key)))
      }
      if ('serviceWorker' in navigator) {
        const registrations = await navigator.serviceWorker.getRegistrations()
        await Promise.all(registrations.map((reg) => reg.unregister()))
      }
    } catch (e) {
      console.warn('Lỗi khi xóa cache cập nhật:', e)
    }
    const cleanUrl = window.location.origin + window.location.pathname
    window.location.replace(`${cleanUrl}?_reload=${Date.now()}`)
  }

  async function handleOwnerAvatarFile(file: File) {
    setMemberError('')
    try {
      const dataUrl = await compressImageFile(file, 128)
      await onUpdateOwnerAvatar(dataUrl)
    } catch {
      setMemberError('Không thể xử lý ảnh đại diện tài khoản.')
    }
  }

  async function handleMemberAvatarFile(memberId: string, file: File) {
    setMemberError('')
    try {
      const dataUrl = await compressImageFile(file, 128)
      await onUpdateMemberAvatar(memberId, dataUrl)
    } catch {
      setMemberError('Không thể xử lý ảnh đại diện thành viên.')
    }
  }

  async function submitNewMember(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const name = newMemberName.trim()
    if (!name) return
    setSavingMember(true); setMemberError('')
    try { await onAddMember(name); setNewMemberName(''); setAddingMember(false) }
    catch (error) { setMemberError(error instanceof Error ? error.message : 'Không thể thêm thành viên.') }
    finally { setSavingMember(false) }
  }

  async function submitEditMember(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const name = editMemberName.trim()
    if (!name || !editingMember) return
    if (name === editingMember.name) {
      setEditingMember(null)
      return
    }
    setSavingMember(true); setMemberError('')
    try {
      await onRenameMember(editingMember.id, name)
      setEditingMember(null); setEditMemberName('')
    }
    catch (error) { setMemberError(error instanceof Error ? error.message : 'Không thể đổi tên thành viên.') }
    finally { setSavingMember(false) }
  }

  return <Modal centered eyebrow={null} title="Tài khoản" subtitle={cloudEnabled ? 'Tài khoản quản lý' : 'Lưu trên thiết bị này'} onClose={onClose}>
    <input
      ref={ownerFileInputRef}
      type="file"
      accept="image/*"
      style={{ display: 'none' }}
      onChange={(e) => {
        const file = e.target.files?.[0]
        if (file) void handleOwnerAvatarFile(file)
        e.target.value = ''
      }}
    />
    <input
      ref={memberFileInputRef}
      type="file"
      accept="image/*"
      style={{ display: 'none' }}
      onChange={(e) => {
        const file = e.target.files?.[0]
        const id = targetMemberIdRef.current
        if (file && id) void handleMemberAvatarFile(id, file)
        e.target.value = ''
      }}
    />
    <div className="account-modal-info">
      {/* NOTE(VI): Lý do: Bấm vào avatar tài khoản để đổi ảnh đại diện
          Trước: Chỉ là icon cố định
          Sau: Nút bấm có biểu tượng camera overlay, bấm vào mở chọn ảnh và lưu
          Test: Bấm vào avatar tài khoản -> chọn ảnh -> ảnh đại diện cập nhật cả ở modal và topbar */}
      {/* NOTE(VI): Lý do: Bấm vào avatar để phóng to xem ảnh, bấm icon máy ảnh nhỏ để đổi avatar
          Trước: Bấm vào avatar mở ngay file picker đổi ảnh
          Sau: Bấm avatar phóng to ảnh preview, bấm icon camera để chọn file đổi ảnh
          Test: Bấm vào avatar xem ảnh to; bấm nút camera đổi avatar */}
      <div className="account-avatar-wrapper">
        <button
          type="button"
          className="account-avatar-btn"
          onClick={() => setPreviewAvatar({
            url: ownerAvatarUrl,
            name: email || 'Tài khoản quản lý',
            initial: (email?.charAt(0) || 'U').toUpperCase(),
            color: '#257b5c',
          })}
          title="Bấm để xem ảnh phóng to"
        >
          <AccountAvatar avatarUrl={ownerAvatarUrl} className="large" size={20} />
        </button>
        <button
          type="button"
          className="account-avatar-cam-btn"
          onClick={() => ownerFileInputRef.current?.click()}
          title="Đổi avatar tài khoản"
        >
          <Camera size={11} />
        </button>
      </div>
      <div><span>Email đăng nhập</span><strong>{email || (cloudEnabled ? 'Chưa đăng nhập' : 'Không dùng tài khoản')}</strong></div>
    </div>
    <section className="account-group-info">
      <div className="account-group-heading"><span>Thông tin nhóm</span></div>
      {/* NOTE(VI): Lý do: Bấm vào avatar của thành viên để đổi ảnh đại diện trực tiếp
          Trước: Avatar chỉ là chữ cái viết tắt
          Sau: Click vào avatar circle mở chọn ảnh từ máy; click vào phần tên mở đổi tên
          Test: Bấm vào hình tròn avatar của thành viên bất kỳ -> chọn ảnh -> avatar thành viên đổi ngay */}
      {/* NOTE(VI): Lý do: Bình thường không hiện camera, click avatar phóng to; click tên hiện đổi tên và icon camera
          Trước: Mọi avatar đều có icon camera cố định và click avatar thì đổi ảnh
          Sau: Bình thường click avatar mở lightbox xem to. Click tên mở chế độ đổi tên, trong chế độ này avatar hiện icon camera và click vào thì đổi ảnh
          Test: Bấm avatar thành viên xem ảnh to; bấm tên vào form sửa tên và thấy icon máy ảnh xuất hiện */}
      <div className="account-group-members">
        {activeMembers.map((member, index) => {
          const isEditing = editingMember?.id === member.id
          return (
            <div
              key={member.id}
              className={`account-group-member ${isEditing ? 'active' : ''}`}
            >
              <span
                className={`member-avatar-click-zone ${isEditing ? 'is-editing' : ''}`}
                onClick={(e) => {
                  e.stopPropagation()
                  if (isEditing) {
                    targetMemberIdRef.current = member.id
                    memberFileInputRef.current?.click()
                  } else {
                    setPreviewAvatar({
                      url: member.avatarUrl,
                      name: member.name,
                      color: memberColor(index),
                      initial: (member.name.trim().charAt(0) || '?').toUpperCase(),
                    })
                  }
                }}
                title={isEditing ? 'Bấm vào avatar để đổi ảnh đại diện' : 'Bấm để xem ảnh phóng to'}
              >
                <MemberAvatar member={member} index={index} className="tiny" />
                {isEditing && (
                  <span className="avatar-cam-badge">
                    <Camera size={9} />
                  </span>
                )}
              </span>
              <span
                className="member-name-clickable"
                onClick={() => {
                  setAddingMember(false)
                  setMemberError('')
                  setEditingMember(member)
                  setEditMemberName(member.name)
                }}
                title="Bấm để đổi tên thành viên"
              >
                {member.name}
              </span>
            </div>
          )
        })}
      </div>
      {!addingMember && !editingMember && (
        <button type="button" className="button secondary account-manage-members" onClick={() => { setAddingMember(true); setMemberError('') }}>
          <UserRoundPlus size={15} /> Thêm thành viên
        </button>
      )}
      {addingMember && (
        <form className="account-add-member-form" onSubmit={(event) => void submitNewMember(event)}>
          <label>Tên thành viên mới<input autoFocus value={newMemberName} onChange={(event) => setNewMemberName(event.target.value)} maxLength={60} placeholder="Nhập tên thành viên" required /></label>
          {memberError && <div className="form-error">{memberError}</div>}
          <div>
            <button type="button" className="button secondary" disabled={savingMember} onClick={() => { setAddingMember(false); setNewMemberName(''); setMemberError('') }}>Hủy</button>
            <button type="submit" className="button primary" disabled={savingMember || !newMemberName.trim()}>{savingMember ? 'Đang thêm...' : 'Thêm'}</button>
          </div>
        </form>
      )}
      {editingMember && (
        <form className="account-add-member-form" onSubmit={(event) => void submitEditMember(event)}>
          {/* NOTE(VI): Lý do: Bỏ nút "Đổi ảnh" thừa vì click vào avatar ở chế độ sửa tên đã mở file picker rồi
              Trước: Có nút "Đổi ảnh" riêng bên cạnh ô nhập tên
              Sau: Chỉ còn label + input, bấm vào avatar để đổi ảnh
              Test: Bấm tên thành viên > chế độ sửa tên hiện ra, click avatar thành viên đó để đổi ảnh */}
          <label>Đổi tên thành viên: <strong>{editingMember.name}</strong>
            <input autoFocus value={editMemberName} onChange={(event) => setEditMemberName(event.target.value)} maxLength={60} placeholder="Nhập tên mới" required />
          </label>
          {memberError && <div className="form-error">{memberError}</div>}
          <div>
            <button type="button" className="button secondary" disabled={savingMember} onClick={() => { setEditingMember(null); setEditMemberName(''); setMemberError('') }}>Hủy</button>
            <button type="submit" className="button primary" disabled={savingMember || !editMemberName.trim()}>{savingMember ? 'Đang lưu...' : 'Lưu tên'}</button>
          </div>
        </form>
      )}
    </section>
    {/* NOTE(VI): Lý do: Bổ sung mục "Thông tin phiên bản" có nút kiểm tra bản mới và cập nhật
        Trước: Chỉ có 1 dòng text nhỏ hiển thị số phiên bản
        Sau: Section đầy đủ hiển thị số bản hiện tại, nút "Kiểm tra bản mới", thông báo trạng thái và nút "Cập nhật ngay" nếu có bản mới
        Test: Mở modal Tài khoản -> Bấm "Kiểm tra bản mới" -> Hiện thông báo kiểm tra hoặc nút Cập nhật ngay */}
    <section className="account-version-info">
      <div className="account-version-header">
        <div>
          <span className="account-version-title">Thông tin phiên bản</span>
          <div className="account-version-number">
            Bản hiện tại: <strong>v{currentAppVersion}</strong>
          </div>
        </div>
        <button
          type="button"
          className="button secondary version-check-btn"
          disabled={checkingVersion}
          onClick={() => void handleCheckVersion()}
          title="Kiểm tra xem có phiên bản mới không"
        >
          <RefreshCw size={13} className={checkingVersion ? 'spin' : ''} />
          {checkingVersion ? 'Đang kiểm tra...' : 'Kiểm tra bản mới'}
        </button>
      </div>

      {versionStatus === 'latest' && (
        <div className="version-status-msg success">
          <Check size={14} /> Bạn đang dùng phiên bản mới nhất!
        </div>
      )}

      {versionStatus === 'has_update' && (
        <div className="version-update-card">
          <div className="version-update-text">
            <Sparkles size={14} color="#e6a448" />
            <span>Đã có phiên bản mới: <strong>v{latestVersion}</strong></span>
          </div>
          <button
            type="button"
            className="button primary version-update-btn"
            disabled={updatingVersion}
            onClick={() => void handleApplyUpdate()}
          >
            <RefreshCw size={13} className={updatingVersion ? 'spin' : ''} />
            {updatingVersion ? 'Đang cập nhật...' : 'Cập nhật ngay'}
          </button>
        </div>
      )}

      {versionStatus === 'error' && (
        <div className="version-status-msg error">
          Không thể kiểm tra bản mới. Vui lòng thử lại sau.
        </div>
      )}
    </section>
    {cloudEnabled && <button className="account-logout" onClick={onLogout}><LogOut size={16} /> Đăng xuất</button>}
    {previewAvatar && (
      <div className="avatar-lightbox-backdrop" onClick={() => setPreviewAvatar(null)}>
        <div className="avatar-lightbox-card" onClick={(e) => e.stopPropagation()}>
          <button
            type="button"
            className="avatar-lightbox-close"
            onClick={() => setPreviewAvatar(null)}
            title="Đóng xem ảnh"
          >
            <X size={16} />
          </button>
          <div className="avatar-lightbox-image-wrap">
            {previewAvatar.url ? (
              <img src={previewAvatar.url} alt={previewAvatar.name} className="avatar-lightbox-img" />
            ) : (
              <div
                className="avatar-lightbox-fallback"
                style={{ background: previewAvatar.color || '#257b5c' }}
              >
                {previewAvatar.initial || '?'}
              </div>
            )}
          </div>
          <div className="avatar-lightbox-name">{previewAvatar.name}</div>
        </div>
      </div>
    )}
  </Modal>
}

// NOTE(VI): Lý do: Modal xem chi tiết hóa đơn đã chốt kỳ khi bấm vào icon Info cạnh icon khóa
// Trước: Không có modal xem thông tin cho hóa đơn đã khóa
// Sau: Hiển thị đầy đủ thông tin: tên khoản chi, số tiền, danh mục, người trả, ngày chi, kỳ quyết toán, con dấu ĐÃ THANH TOÁN, ghi chú và danh sách chia tiền từng thành viên
// Test: Bấm icon Info trên hóa đơn đã chốt kỳ -> Modal chi tiết mở lên rõ ràng, đầy đủ thông tin; bấm Đóng để tắt
function ExpenseDetailModal({
  expense,
  members,
  periods,
  onClose,
}: {
  expense: Expense
  members: Member[]
  periods: SettlementPeriod[]
  onClose: () => void
}) {
  const payer = members.find((m) => m.id === expense.payerId)
  const Icon = categoryIcon(expense.category)
  const period = periods.find((p) => p.id === expense.periodId)
  // NOTE(VI): Lý do: Phân biệt rõ các chế độ chia tiền và chỉ hiển thị % khi hóa đơn chia theo % (làm tròn số nguyên)
  // Trước: Hiển thị (x.x%) cho tất cả các loại hóa đơn, kể cả chia đều; lặp toàn bộ expense.splits
  // Sau: Lọc activeSplits (amount > 0). Chia đều: hiện badge 'Chia đều', không hiện (%). Chia số tiền: hiện badge 'Theo số tiền', không hiện (%). Chia %: hiện badge 'Theo tỷ lệ %' và (x%) số nguyên
  // Test: Mở modal xem hóa đơn chia đều -> chỉ thấy tên và số tiền, không thấy %; hóa đơn chia theo % -> thấy % nguyên (vd 10%, 33%)
  const activeSplits = expense.splits.filter((split) => split.amount > 0)
  const isEqual = expense.splitMode === 'equal'
  const isPercent = expense.splitMode === 'percent'
  const isCustomAmount = !isEqual && !isPercent

  return (
    <Modal centered wide eyebrow="SỔ CHI TIÊU NHÓM" title="Chi tiết khoản chi" subtitle="" onClose={onClose}>
      <div style={{ display: 'grid', gap: '14px', padding: '6px 0 16px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderBottom: '1px solid #eeeee9', paddingBottom: '12px', gap: '8px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <span className="expense-icon" style={{ width: '34px', height: '34px', display: 'grid', placeItems: 'center', background: '#e8f1e9', color: '#297555', borderRadius: '10px' }}>
              <Icon size={18} />
            </span>
            <div>
              <strong style={{ fontSize: '15px', color: '#202722', display: 'block' }}>{expense.title}</strong>
              <span style={{ fontSize: '11px', color: '#888f86' }}>{expense.category}</span>
            </div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <strong style={{ fontSize: '16px', color: '#222924', display: 'block' }}>{money(expense.amount)}</strong>
            {period && period.status !== 'open' && (
              <div className="paid-stamp" style={{ transform: 'none', margin: '3px 0 0 auto', padding: '2px 7px' }}>
                <strong style={{ fontSize: '10px', color: '#c32026', fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "DM Sans", sans-serif', fontWeight: 500, letterSpacing: '0.4px' }}>ĐÃ CHỐT SỔ</strong>
              </div>
            )}
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px', fontSize: '12px' }}>
          <div>
            <span style={{ color: '#888f86', display: 'block', marginBottom: '2px' }}>Người đã trả</span>
            <strong>{payer?.name ?? 'Thành viên đã ngừng hoạt động'}</strong>
          </div>
          <div>
            <span style={{ color: '#888f86', display: 'block', marginBottom: '2px' }}>Ngày chi</span>
            <strong>{formatDate(expense.date)}</strong>
          </div>
          {period && (
            <div style={{ gridColumn: 'span 2' }}>
              <span style={{ color: '#888f86', display: 'block', marginBottom: '2px' }}>Kỳ chốt sổ</span>
              <span>{period.endDate ? `Từ ${formatDate(period.startDate)} đến ${formatDate(period.endDate)}` : `Từ ${formatDate(period.startDate)} đến nay`}</span>
            </div>
          )}
          {expense.note && (
            <div style={{ gridColumn: 'span 2' }}>
              <span style={{ color: '#888f86', display: 'block', marginBottom: '2px' }}>Ghi chú</span>
              <p style={{ margin: 0, color: '#444d46', background: '#f6f7f3', padding: '8px 10px', borderRadius: '7px', fontSize: '11.5px' }}>{expense.note}</p>
            </div>
          )}
        </div>

        <div style={{ borderTop: '1px solid #eeeee9', paddingTop: '10px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
            <span style={{ fontSize: '11px', fontWeight: 700, color: '#7a8179', letterSpacing: '0.3px' }}>
              PHẦN CHIA ({activeSplits.length} THÀNH VIÊN)
            </span>
            {isEqual && (
              <span style={{ fontSize: '11px', fontWeight: 600, color: '#257b5c', background: '#eaf4ee', padding: '2px 8px', borderRadius: '12px' }}>
                Chia đều
              </span>
            )}
            {isPercent && (
              <span style={{ fontSize: '11px', fontWeight: 600, color: '#257b5c', background: '#eaf4ee', padding: '2px 8px', borderRadius: '12px' }}>
                Theo tỷ lệ %
              </span>
            )}
            {isCustomAmount && (
              <span style={{ fontSize: '11px', fontWeight: 600, color: '#526056', background: '#eef0eb', padding: '2px 8px', borderRadius: '12px' }}>
                Theo số tiền
              </span>
            )}
          </div>
          <div style={{ display: 'grid', gap: '6px' }}>
            {activeSplits.map((split) => {
              const member = members.find((m) => m.id === split.memberId)
              const memberIdx = members.findIndex((m) => m.id === split.memberId)
              const percent = expense.amount > 0 ? Math.round((split.amount / expense.amount) * 100) : 0
              return (
                <div key={split.memberId} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 10px', background: '#fafbf8', borderRadius: '8px', fontSize: '12px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <MemberAvatar member={member} index={memberIdx >= 0 ? memberIdx : 0} className="tiny" />
                    <span>{member?.name ?? 'Thành viên'}</span>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <strong style={{ color: '#252d28' }}>{money(split.amount)}</strong>
                    {isPercent && (
                      <small style={{ color: '#91988f', marginLeft: '6px', fontSize: '10px' }}>({percent}%)</small>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </div>

        <div className="modal-actions" style={{ marginTop: '4px' }}>
          <button type="button" className="button primary full" onClick={onClose}>
            Đóng
          </button>
        </div>
      </div>
    </Modal>
  )
}

function ExpenseModal({ members, initial, minDate, onClose, onSave }: { members: Member[]; initial: Expense | null; minDate?: string; onClose: () => void; onSave: (expense: Expense) => void }) {
  const [title, setTitle] = useState(initial?.title ?? '')
  const [amount, setAmount] = useState(initial?.amount ? String(initial.amount) : '')
  const [payerId, setPayerId] = useState(initial?.payerId ?? members[0]?.id ?? '')
  const [date, setDate] = useState(initial?.date ?? today())
  const [category, setCategory] = useState(initial?.category ?? categories[0])
  const [note, setNote] = useState(initial?.note ?? '')
  const [selected, setSelected] = useState<string[]>(() => {
    if (initial) return initial.splits.map((item) => item.memberId)
    try {
      const saved = JSON.parse(localStorage.getItem('expense-split-member-ids') ?? 'null')
      if (Array.isArray(saved)) {
        const savedIds = new Set(saved.filter((id): id is string => typeof id === 'string'))
        const remembered = members.filter((member) => savedIds.has(member.id)).map((member) => member.id)
        if (remembered.length) return remembered
      }
    } catch { /* Use all members if local storage is unavailable. */ }
    return members.map((member) => member.id)
  })
  const [splitMode, setSplitMode] = useState<'equal' | 'custom'>(initial?.splitMode === 'equal' ? 'equal' : 'custom')
  const [custom, setCustom] = useState<Record<string, string>>(Object.fromEntries(initial?.splits.map((item) => [item.memberId, String(item.amount)]) ?? []))
  const [splitByPercent, setSplitByPercent] = useState(() => initial?.splitMode === 'custom' ? false : true)
  const [percentages, setPercentages] = useState<Record<string, string>>(() => {
    const splits = initial?.splits ?? []
    if (!initial || initial.amount <= 0 || !splits.length) return {}
    const values: Record<string, string> = {}
    let assigned = 0
    splits.forEach((item, index) => {
      const value = index === splits.length - 1 ? 100 - assigned : Number((item.amount / initial.amount * 100).toFixed(4))
      values[item.memberId] = String(Number(value.toFixed(4)))
      assigned += value
    })
    return values
  })
  const numericAmount = Math.round(Number(amount.replace(/[,.\s]/g, '')))
  const equal = equalSplits(numericAmount || 0, selected)
  const customTotal = selected.reduce((sum, memberId) => sum + Math.round(Number((custom[memberId] ?? '0').replace(/[,.\s]/g, ''))), 0)
  const percentTotal = selected.reduce((sum, memberId) => sum + (Number((percentages[memberId] ?? '0').replace(',', '.')) || 0), 0)
  const percentagesValid = Math.round(percentTotal * 100) === 10000
  const percentSplits = selected.map((memberId, index) => {
    const amount = percentagesValid && index === selected.length - 1
      ? numericAmount - selected.slice(0, index).reduce((sum, id) => sum + Math.round(numericAmount * (Number((percentages[id] ?? '0').replace(',', '.')) || 0) / 100), 0)
      : Math.round(numericAmount * (Number((percentages[memberId] ?? '0').replace(',', '.')) || 0) / 100)
    return { memberId, amount }
  })
  const customPercentTotal = percentSplits.reduce((sum, item) => sum + item.amount, 0)
  const splitTotal = splitMode === 'equal' ? numericAmount : splitByPercent ? customPercentTotal : customTotal
  // NOTE(VI): Lý do: Cho phép lưu ngày chi cũ hơn ngày mở kỳ (trường hợp quên ghi ngay hôm trước), hiển thị chú ý màu vàng nhưng KHÔNG chặn lưu
  // Trước: Chặn lưu bằng isDateInvalid và min={minDate}
  // Sau: Bỏ chặn minDate và isDateInvalid, hiển thị chú ý nhẹ nhàng và vẫn cho lưu bình thường
  // Test: Chọn ngày hôm qua hoặc ngày trước ngày mở kỳ -> xuất hiện chú ý vàng nhưng nút "Lưu khoản chi" vẫn bấm lưu thành công
  const isDateBeforePeriod = Boolean(minDate && date < minDate)
  const splitIsValid = splitMode === 'equal' || (splitByPercent ? percentagesValid : splitTotal === numericAmount)
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const splits = splitMode === 'equal' ? equal : splitByPercent ? percentSplits : selected.map((memberId) => ({ memberId, amount: Math.round(Number((custom[memberId] ?? '0').replace(/[,.\s]/g, ''))) }))
    if (!title.trim() || numericAmount < 1 || !selected.length || !splitIsValid) return
    const finalSplitMode: 'equal' | 'custom' | 'percent' = splitMode === 'equal' ? 'equal' : splitByPercent ? 'percent' : 'custom'
    onSave({ id: initial?.id ?? makeId(), title: title.trim(), amount: numericAmount, payerId, date, category, note: note.trim(), splitMode: finalSplitMode, splits, periodId: initial?.periodId ?? null, updatedAt: new Date().toISOString() })
  }
  const updateSelected = (next: string[]) => {
    setSelected(next)
    try { localStorage.setItem('expense-split-member-ids', JSON.stringify(next)) } catch { /* Selection remains available for this entry. */ }
  }
  const toggleMember = (memberId: string) => updateSelected(selected.includes(memberId) ? selected.filter((id) => id !== memberId) : [...selected, memberId])
  const selectAllMembers = () => updateSelected(selected.length === members.length ? [] : members.map((member) => member.id))
  const setPercent = (memberId: string, value: string) => setPercentages((current) => ({ ...current, [memberId]: value.replace(',', '.').replace(/[^\d.]/g, '').replace(/(\..*)\./g, '$1') }))
  return <Modal centered wide eyebrow={null} title={initial ? 'Sửa khoản chi' : 'Thêm khoản chi'} subtitle="" onClose={onClose}><form onSubmit={submit} className="expense-form">
    <label>Tên khoản chi<input autoFocus placeholder="Ví dụ: Bữa tối ngày đầu" value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={100} /></label>
    <div className="form-two"><label>Số tiền<span className="input-suffix"><input inputMode="numeric" placeholder="0" value={amount ? new Intl.NumberFormat('vi-VN').format(Number(amount.replace(/[,.\s]/g, ''))) : ''} onChange={(e) => setAmount(e.target.value.replace(/\D/g, ''))} required /><b>₫</b></span></label><label>Ngày chi<input type="date" value={date} onChange={(e) => setDate(e.target.value)} required />{isDateBeforePeriod && <span className="date-hint">Chú ý: Ngày chi trước ngày mở kỳ ({minDate && formatDate(minDate)}), vẫn được lưu vào kỳ này.</span>}</label></div>
    <div className="form-two"><label>Người đã trả<select value={payerId} onChange={(e) => setPayerId(e.target.value)}>{members.map((member) => <option key={member.id} value={member.id}>{member.name}</option>)}</select></label><label>Danh mục<select value={category} onChange={(e) => setCategory(e.target.value)}>{categories.map((item) => <option key={item}>{item}</option>)}</select></label></div>
    <div className="form-label-row"><span>Chia cho ai?</span><button type="button" className="text-button inline" onClick={selectAllMembers}>{selected.length === members.length ? 'Bỏ chọn tất cả' : 'Chọn tất cả'}</button></div>
    <div className="member-chips">{members.map((member, index) => <button type="button" key={member.id} className={`member-chip ${selected.includes(member.id) ? 'selected' : ''}`} onClick={() => toggleMember(member.id)}><MemberAvatar member={member} index={index} className="tiny" />{member.name}{selected.includes(member.id) && <Check size={13} />}</button>)}</div>
    <div className="split-toggle"><button type="button" className={splitMode === 'equal' ? 'selected' : ''} onClick={() => setSplitMode('equal')}>Chia đều</button><button type="button" className={splitMode === 'custom' ? 'selected' : ''} onClick={() => setSplitMode('custom')}>Tùy chỉnh số tiền</button></div>
    {splitMode === 'custom' && <div className="custom-splits"><div className="custom-splits-header"><label className="percentage-toggle"><input type="checkbox" checked={splitByPercent} onChange={(event) => setSplitByPercent(event.target.checked)} /><span>Chia theo %</span></label>{splitByPercent && <small>Tổng phải bằng 100%</small>}</div>{members.filter((member) => selected.includes(member.id)).map((member) => {
      const splitAmount = percentSplits.find((item) => item.memberId === member.id)?.amount ?? 0
      return <label className="custom-split-row" key={member.id}><span>{member.name}</span>{splitByPercent ? <span className="split-input-pair"><input aria-label={`Tỷ lệ chia của ${member.name}`} inputMode="decimal" placeholder="%" value={percentages[member.id] ?? ''} onChange={(event) => setPercent(member.id, event.target.value)} /><input aria-label={`Số tiền của ${member.name}`} placeholder="VND" value={numericAmount ? new Intl.NumberFormat('vi-VN').format(splitAmount) : ''} readOnly /></span> : <input className="custom-amount-input" aria-label={`Số tiền của ${member.name}`} inputMode="numeric" placeholder="VND" value={custom[member.id] ? new Intl.NumberFormat('vi-VN').format(Number(custom[member.id].replace(/[,.\s]/g, ''))) : ''} onChange={(event) => setCustom({ ...custom, [member.id]: event.target.value.replace(/\D/g, '') })} />}</label>
    })}</div>}
    <div className={`split-summary ${!splitIsValid ? 'invalid' : ''}`}><span>{splitMode === 'custom' && splitByPercent ? 'Tổng tỷ lệ' : 'Tổng phần chia'}</span><strong>{splitMode === 'custom' && splitByPercent ? `${Number(percentTotal.toFixed(2))}%` : money(splitTotal || 0)}{!splitIsValid && <small>{splitByPercent ? ' · Cần đủ 100%' : ` · Cần khớp ${money(numericAmount || 0)}`}</small>}</strong></div>
    <label>Ghi chú <span className="optional">(không bắt buộc)</span><textarea rows={2} maxLength={400} placeholder="Thêm thông tin nếu cần..." value={note} onChange={(e) => setNote(e.target.value)} /></label>
    <div className="modal-actions"><button type="button" className="button secondary" onClick={onClose}>Hủy</button><button className="button primary" disabled={!title.trim() || numericAmount < 1 || !selected.length || !splitIsValid}><Check size={16} /> Lưu khoản chi</button></div>
  </form></Modal>
}

function SettlementModal({ members, suggestions, onClose, onSave }: { members: Member[]; suggestions: ReturnType<typeof suggestSettlements>; onClose: () => void; onSave: (from: string, to: string, amount: number, note: string) => void }) {
  const suggestion = suggestions[0]
  const [from, setFrom] = useState(suggestion?.fromMemberId ?? members[0]?.id ?? '')
  const [to, setTo] = useState(suggestion?.toMemberId ?? members[1]?.id ?? '')
  const [amount, setAmount] = useState(suggestion ? String(suggestion.amount) : '')
  const [note, setNote] = useState('')
  return <Modal centered wide title="Ghi nhận chốt sổ" subtitle="Lưu lại khoản tiền một thành viên đã trả." onClose={onClose}><form className="expense-form" onSubmit={(event) => { event.preventDefault(); const value = Number(amount.replace(/[,.\s]/g, '')); if (value > 0 && from !== to) onSave(from, to, value, note.trim()) }}>
    <div className="form-two"><label>Người trả<select value={from} onChange={(e) => setFrom(e.target.value)}>{members.map((member) => <option key={member.id} value={member.id}>{member.name}</option>)}</select></label><label>Người nhận<select value={to} onChange={(e) => setTo(e.target.value)}>{members.filter((member) => member.id !== from).map((member) => <option key={member.id} value={member.id}>{member.name}</option>)}</select></label></div>
    <label>Số tiền<span className="input-suffix"><input inputMode="numeric" placeholder="0" value={amount ? new Intl.NumberFormat('vi-VN').format(Number(amount.replace(/[,.\s]/g, ''))) : ''} onChange={(e) => setAmount(e.target.value.replace(/\D/g, ''))} required /><b>₫</b></span></label><label>Ngày trả<input type="date" defaultValue={today()} disabled /></label><label>Ghi chú <span className="optional">(không bắt buộc)</span><textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Ví dụ: Chuyển khoản ngân hàng" /></label>
    <div className="modal-actions"><button type="button" className="button secondary" onClick={onClose}>Hủy</button><button className="button primary" disabled={Number(amount) < 1 || from === to}><Check size={16} /> Ghi nhận</button></div>
  </form></Modal>
}

function Modal({ title, subtitle, onClose, children, centered = false, wide = false, eyebrow = 'SỔ CHI TIÊU NHÓM', className = '' }: { title: string; subtitle: string; onClose: () => void; children: React.ReactNode; centered?: boolean; wide?: boolean; eyebrow?: string | null; className?: string }) {
  useEffect(() => { const handler = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }; window.addEventListener('keydown', handler); document.body.style.overflow = 'hidden'; return () => { window.removeEventListener('keydown', handler); document.body.style.overflow = '' } }, [onClose])
  return <div className={`modal-backdrop ${centered ? 'centered-backdrop' : ''} ${className}`} onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}><section className={`modal-card ${centered ? 'centered-modal' : ''} ${wide ? 'wide-modal' : ''}`}><div className="modal-heading"><div>{eyebrow && <span className="eyebrow">{eyebrow}</span>}<h2>{title}</h2>{subtitle && <p>{subtitle}</p>}</div><button className="icon-button" onClick={onClose} aria-label="Đóng"><X size={18} /></button></div>{children}</section></div>
}
