import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import {
  ArrowRight, ArrowUpRight, Check, ChevronDown, ChevronLeft, ChevronRight,
  Camera, CircleHelp, Cloud, CloudOff, Copy, DollarSign, Download, Film, Filter, History, Info, LogOut, Pencil, Plane, Printer, UserRound,
  Plus, ReceiptText, RefreshCw, ShoppingCart, Sparkles, Utensils, UserRoundPlus, LockKeyhole,
  Wallet, X,
} from 'lucide-react'
import { toCanvas } from 'html-to-image'
import JSZip from 'jszip'
import {
  equalSplits, getBalances, getMemberDebtBreakdown, getUnpaidTotal, makeDemoLedger, makeId, memberColor, money, normalizeLedger,
  markClosedPeriodsSettled, suggestSettlements, today, type Expense, type Ledger, type Member, type Operation, type Settlement, type SettlementPeriod,
} from './domain'
import { clearQueue, queueOperation, readLedger, readQueue, removeOperation, replaceOperation, writeLedger } from './lib/localStore'
import {
  fetchCloudLedger, fetchMonthlyExpenseTotals, initializeCloudLedger, isCloudConfigured, signIn, signOut, signUp, supabase, syncOperation,
} from './lib/supabase'
import { QR_PAYMENT_DATA_URL } from './qrData'


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
  const [modal, setModal] = useState<'expense' | 'confirm_settlement' | null>(null)
  const [showSettlementSection, setShowSettlementSection] = useState(false)
  const [showSettlementHistoryModal, setShowSettlementHistoryModal] = useState(false)
  const [pendingSettlement, setPendingSettlement] = useState<{ fromMemberId: string; toMemberId: string; amount: number; periodId: string } | null>(null)
  const [pendingSettlementDelete, setPendingSettlementDelete] = useState<Settlement | null>(null)
  // NOTE(VI): Lý do: Bổ sung popup xác nhận trước khi chốt kỳ để tránh bấm nhầm
  // Trước: Bấm Chốt kỳ lập tức chốt luôn không hỏi lại
  // Sau: Hiện popup xác nhận, người dùng bấm "Xác nhận chốt kỳ" mới tiến hành chốt
  // Test: Vào menu Quyết toán -> Bấm Chốt kỳ -> Hiện popup hỏi -> Bấm Quay lại thì đóng popup -> Bấm Xác nhận chốt kỳ thì thực hiện chốt
  const [showClosePeriodConfirm, setShowClosePeriodConfirm] = useState(false)
  const [settlementHistoryPage, setSettlementHistoryPage] = useState(1)
  const [showSettlementFilters, setShowSettlementFilters] = useState(false)
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

  // NOTE(VI): Lý do: Hỗ trợ mở và sử dụng app hoàn toàn khi mất mạng (Offline) mà không bị văng ra màn hình đăng nhập hoặc treo ở màn hình tải
  // Trước: Khi mất mạng và bấm F5 / mở lại app, nếu token Supabase cần refresh qua mạng bị lỗi thì getSession()/onAuthStateChange trả về null, khiến app xóa ledger trên RAM và bắt đăng nhập lại (hoặc treo nếu promise lỗi)
  // Sau: Lưu trạng thái đã đăng nhập (chia-tien-offline-email) và kiểm tra dữ liệu sổ trong IndexedDB (readLedger). Khi mất mạng (!navigator.onLine) hoặc lỗi mạng lúc getSession, tự động khôi phục phiên offline và nạp ngay sổ chi tiêu từ IndexedDB
  // Test: Đăng nhập mở app -> tắt mạng (Offline) -> bấm F5 tải lại trang -> App vào thẳng sổ chi tiêu từ DB offline, thêm/sửa khoản chi bình thường
  useEffect(() => {
    if (!supabase) { void hydrate(false); return }
    let cancelled = false

    const tryRestoreOfflineSession = async () => {
      const saved = await readLedger()
      let cachedEmail = ''
      try { cachedEmail = localStorage.getItem('chia-tien-offline-email') ?? '' } catch {}
      if (cancelled) return false
      if (saved || cachedEmail) {
        setUserEmail((prev) => prev || cachedEmail)
        setSession(true)
        setSessionReady(true)
        void hydrate(false)
        return true
      }
      return false
    }

    if (!navigator.onLine) {
      void tryRestoreOfflineSession().then((restored) => {
        if (!restored && !cancelled) setSessionReady(true)
      })
    }

    void supabase.auth.getSession()
      .then(async ({ data }) => {
        if (cancelled) return
        const authenticated = Boolean(data.session)
        if (authenticated) {
          const email = data.session?.user.email ?? ''
          try { localStorage.setItem('chia-tien-offline-email', email || 'offline') } catch {}
          setUserEmail(email)
          setSession(true)
          setSessionReady(true)
          void hydrate(true)
        } else if (!navigator.onLine) {
          const restored = await tryRestoreOfflineSession()
          if (!restored && !cancelled) {
            setSession(false)
            setSessionReady(true)
          }
        } else {
          setUserEmail('')
          setSession(false)
          setSessionReady(true)
        }
      })
      .catch(async () => {
        if (cancelled) return
        const restored = await tryRestoreOfflineSession()
        if (!restored && !cancelled) {
          setSessionReady(true)
        }
      })

    const { data: listener } = supabase.auth.onAuthStateChange((event, authSession) => {
      if (cancelled) return
      const authenticated = Boolean(authSession)
      if (authenticated) {
        const email = authSession?.user.email ?? ''
        try { localStorage.setItem('chia-tien-offline-email', email || 'offline') } catch {}
        setUserEmail(email)
        setSession(true)
        setSessionReady(true)
        void hydrate(true)
      } else if (!navigator.onLine && event !== 'SIGNED_OUT') {
        void tryRestoreOfflineSession()
      } else {
        setUserEmail('')
        setSession(false)
        setSessionReady(true)
        setLedger(null)
        setNeedsSetup(false)
        setShowAccount(false)
      }
    })
    return () => {
      cancelled = true
      listener.subscription.unsubscribe()
    }
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
      // NOTE(VI): Lý do: Bảo vệ các khoản chi vừa thêm trong lúc đang sync; tránh việc fetchCloudLedger đè mất khoản chi mới thêm
      // Trước: setLedger(fresh) ghi đè thẳng bản server, làm mất khoản chi vừa nhập nếu người dùng lưu khoản chi trong lúc syncOperation đang chạy
      // Sau: Đọc lại queue sau vòng lặp; nếu còn thao tác mới thì merge qua applyPendingOperations trước khi lưu
      // Test: Thêm liên tục 2 khoản chi -> không bao giờ có tình trạng khoản chi thứ 2 bị biến mất tạm thời
      const remainingQueue = await readQueue()
      const merged = remainingQueue.length ? applyPendingOperations(fresh, remainingQueue) : fresh
      setLedger(merged); await writeLedger(merged)
      await refreshMonthlyTotals()
      setPendingCount(remainingQueue.length); setSyncNotice(''); flashSavedStatus()
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
  // NOTE(VI): Lý do: Ẩn thành viên có số dư 0đ ở phần Số dư hiện tại theo yêu cầu người dùng
  // Trước: calculationMembers lọc theo financiallyInvolved (ai từng chi tiêu/chia tiền thì luôn hiển thị kể cả khi số dư đã về 0đ)
  // Sau: Chỉ hiển thị các thành viên có số dư khác 0 (balances.get(member.id) !== 0); thành viên có số dư 0đ sẽ tự động được ẩn
  // Test: Thành viên chuyển tiền xong về 0đ -> lập tức ẩn khỏi Số dư hiện tại, chỉ hiện những ai còn nợ (-) hoặc cần nhận (+)
  const calculationMembers = activeMembers.filter((member) => (balances.get(member.id) ?? 0) !== 0)
  const suggestions = suggestSettlements(ledger)
  const unpaidTotal = getUnpaidTotal(ledger)
  const periodSettlements = ledger.settlements
  const filteredSettlements = periodSettlements.filter((settlement) => {
    if (settlementFilters.fromDate && settlement.date < settlementFilters.fromDate) return false
    if (settlementFilters.toDate && settlement.date > settlementFilters.toDate) return false
    if (settlementFilters.memberId && settlement.fromMemberId !== settlementFilters.memberId && settlement.toMemberId !== settlementFilters.memberId) return false
    return true
  })
  // NOTE(VI): Lý do: Giới hạn lịch sử trả tiền mặc định chỉ hiển thị tối đa 2 trang (30 khoản). Nếu muốn xem nhiều hơn thì dùng bộ lọc
  // Trước: Hiển thị toàn bộ tất cả các trang
  // Sau: Khi không có bộ lọc (mặc định), chỉ hiển thị tối đa 2 trang; khi có bộ lọc thì hiển thị toàn bộ trang phù hợp
  // Test: Danh sách trả tiền có trên 30 khoản -> chỉ lật được 2 trang; bấm Lọc theo ngày/thành viên -> lật được tất cả các trang của kết quả lọc
  const hasSettlementFilter = Boolean(settlementFilters.fromDate || settlementFilters.toDate || settlementFilters.memberId)
  const orderedSettlements = [...filteredSettlements].sort((a, b) => b.date.localeCompare(a.date) || (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '') || b.id.localeCompare(a.id))
  const displaySettlements = hasSettlementFilter ? orderedSettlements : orderedSettlements.slice(0, 30)
  const settlementPageCount = hasSettlementFilter
    ? Math.max(1, Math.ceil(orderedSettlements.length / 15))
    : Math.min(2, Math.max(1, Math.ceil(orderedSettlements.length / 15)))
  const safeSettlementPage = Math.min(settlementHistoryPage, settlementPageCount)
  const visibleSettlements = displaySettlements.slice((safeSettlementPage - 1) * 15, safeSettlementPage * 15)
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
  const allClosedPeriods = ledger.periods
    .filter((period) => period.status !== 'open')
    .sort((a, b) => {
      const dateA = a.endDate ?? a.settledAt ?? a.startDate
      const dateB = b.endDate ?? b.settledAt ?? b.startDate
      return dateB.localeCompare(dateA) || b.startDate.localeCompare(a.startDate)
    })
  const lastClosedPeriod = allClosedPeriods[0]
  const closedPeriods = allClosedPeriods.slice(0, 5)

  // NOTE(VI): Lý do: Mặc định hiển thị lịch sử chi tiêu là các hóa đơn của kỳ hiện tại (chưa chốt sổ) và kỳ vừa mới chốt sổ (kỳ trước kỳ hiện tại); các hóa đơn của các kỳ cũ hơn sẽ được ẩn
  // Trước: Khi không chọn bộ lọc, hiển thị toàn bộ hóa đơn từ trước đến giờ
  // Sau: Mặc định chỉ hiển thị kỳ mở + kỳ vừa chốt gần nhất; nếu muốn xem các kỳ cũ thì chọn "Tất cả các kỳ" hoặc chọn kỳ cụ thể trong bộ lọc
  // Test: Vào Lịch sử chi tiêu -> chỉ thấy hóa đơn kỳ hiện tại và kỳ vừa chốt; hóa đơn kỳ cũ hơn bị ẩn; mở Lọc -> chọn "Tất cả các kỳ" sẽ thấy toàn bộ
  const filteredExpenses = ledger.expenses.filter((expense) => {
    if (expenseFilters.periodId === 'all') {
      // Hiển thị tất cả các kỳ, không lọc theo kỳ
    } else if (expenseFilters.periodId) {
      if (expense.periodId !== expenseFilters.periodId) {
        const isOpen = openPeriod && expenseFilters.periodId === openPeriod.id
        if (!isOpen || expense.periodId) return false
      }
    } else {
      // Mặc định: Chỉ hiển thị kỳ hiện tại (chưa chốt sổ) và kỳ vừa chốt sổ gần nhất
      const isOpenExpense = expense.periodId === openPeriod?.id || (!expense.periodId && Boolean(openPeriod))
      const isLastClosedExpense = Boolean(lastClosedPeriod && expense.periodId === lastClosedPeriod.id)
      if (openPeriod || lastClosedPeriod) {
        if (!isOpenExpense && !isLastClosedExpense) return false
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

  // NOTE(VI): Lý do: Logic in bill thông minh khi chưa chọn bộ lọc:
  // - Nếu có bộ lọc: in theo bộ lọc người dùng chọn
  // - Nếu chưa chọn bộ lọc:
  //   + Nếu kỳ hiện tại (chưa chốt sổ) có hóa đơn -> in kỳ hiện tại
  //   + Nếu kỳ hiện tại chưa có hóa đơn (vừa chốt sổ xong) -> in kỳ vừa chốt sổ gần nhất
  // - Tuyệt đối không dùng hook (useMemo) sau early return (if (!ledger) return ...) vì vi phạm Rules of Hooks của React làm app crash "Rendered more hooks than during the previous render"
  // Trước: useMemo(...) sau dòng if (!ledger) return
  // Sau: Tính toán thuần túy qua IIFE (plain computation) giống filteredExpenses, orderedSettlements
  // Test: Mở app -> app load bình thường không bị màn hình lỗi; bấm In bill in đúng kỳ theo logic
  const billData: { expenses: Expense[]; subtitle: string } = (() => {
    if (activeFilterCount > 0) {
      let subtitle = 'Các khoản chi theo bộ lọc'
      if (expenseFilters.periodId) {
        if (expenseFilters.periodId === 'all') {
          subtitle = 'Toàn bộ các kỳ'
        } else {
          const found = ledger.periods.find((p) => p.id === expenseFilters.periodId)
          if (found) {
            subtitle = found.status === 'open'
              ? `Kỳ hiện tại (từ ${formatDate(found.startDate)} đến nay)`
              : found.endDate
                ? `Kỳ ${formatDate(found.startDate)} – ${formatDate(found.endDate)} (Đã chốt sổ)`
                : `Kỳ từ ${formatDate(found.startDate)} (Đã chốt sổ)`
          }
        }
      }
      // NOTE(VI): Lý do: Sắp xếp hóa đơn in bill theo đúng trình tự thời gian diễn ra thực tế (ngược lại chuẩn xác 100% với danh sách Lịch sử chi tiêu trên App).
      // Ngày: từ cũ đến mới (a.date -> b.date).
      // Trong ngày: khoản nào thêm trước/chi trước in trước, khoản nào thêm sau/chi sau in sau ((a.createdAt ?? a.updatedAt).localeCompare(b.createdAt ?? b.updatedAt)).
      // Trước: a.date.localeCompare(b.date) || a.title.localeCompare(b.title) -> trong ngày bị sắp xếp theo bảng chữ cái A-Z (Q, S, T, V, X...) làm đảo lộn trình tự
      // Sau: a.date.localeCompare(b.date) || (a.createdAt ?? a.updatedAt ?? '').localeCompare(b.createdAt ?? b.updatedAt ?? '')
      // Test: Mở in bill -> các khoản chi trong cùng một ngày được in theo đúng trình tự thời gian thêm (món nào chi trước lên trước, món chi sau nằm sau)
      return {
        expenses: [...filteredExpenses].sort((a, b) => a.date.localeCompare(b.date) || (a.createdAt ?? a.updatedAt ?? '').localeCompare(b.createdAt ?? b.updatedAt ?? '') || a.id.localeCompare(b.id)),
        subtitle,
      }
    }
    const currentPeriodExpenses = ledger.expenses.filter((e) => e.periodId === openPeriod?.id || (!e.periodId && openPeriod))
    if (currentPeriodExpenses.length > 0) {
      return {
        expenses: [...currentPeriodExpenses].sort((a, b) => a.date.localeCompare(b.date) || (a.createdAt ?? a.updatedAt ?? '').localeCompare(b.createdAt ?? b.updatedAt ?? '') || a.id.localeCompare(b.id)),
        subtitle: openPeriod ? `Kỳ hiện tại (từ ${formatDate(openPeriod.startDate)} đến nay)` : 'Kỳ hiện tại (chưa chốt sổ)',
      }
    }
    if (lastClosedPeriod) {
      const closedExpenses = ledger.expenses.filter((e) => e.periodId === lastClosedPeriod.id)
      const periodLabel = lastClosedPeriod.endDate
        ? `Kỳ vừa chốt sổ (${formatDate(lastClosedPeriod.startDate)} – ${formatDate(lastClosedPeriod.endDate)})`
        : `Kỳ vừa chốt sổ (từ ${formatDate(lastClosedPeriod.startDate)})`
      return {
        expenses: [...closedExpenses].sort((a, b) => a.date.localeCompare(b.date) || (a.createdAt ?? a.updatedAt ?? '').localeCompare(b.createdAt ?? b.updatedAt ?? '') || a.id.localeCompare(b.id)),
        subtitle: periodLabel,
      }
    }
    return {
      expenses: [...filteredExpenses].sort((a, b) => a.date.localeCompare(b.date) || (a.createdAt ?? a.updatedAt ?? '').localeCompare(b.createdAt ?? b.updatedAt ?? '') || a.id.localeCompare(b.id)),
      subtitle: 'Toàn bộ khoản chi',
    }
  })()

  async function saveExpense(expense: Expense, previous?: Expense) {
    if (!ledger) return
    try {
      const splitMemberIds = expense.splits.filter((s) => s.amount > 0).map((s) => s.memberId)
      if (splitMemberIds.length > 0) {
        localStorage.setItem('expense-split-member-ids', JSON.stringify(splitMemberIds))
      }
    } catch { /* ignore */ }
    let openPeriod = ledger.periods.find((period) => period.status === 'open')
    let nextPeriods = ledger.periods
    if (!openPeriod) {
      openPeriod = { id: makeId(), startDate: today(), endDate: null, status: 'open', settledAt: null }
      nextPeriods = [...ledger.periods, openPeriod]
    }
    const periodId = expense.periodId ?? openPeriod.id
    const nowIso = new Date().toISOString()
    // NOTE(VI): Lý do: Giữ nguyên vị trí khoản chi khi sửa (không bị nhảy lên đầu)
    // Khi thêm mới: tạo createdAt mới nhất -> tự động nằm trên đầu ngày đó
    // Khi sửa: giữ nguyên createdAt ban đầu -> vị trí tương đối giữa các khoản chi không bị thay đổi
    const createdAt = previous?.createdAt || previous?.updatedAt || expense.createdAt || nowIso
    const record: Expense = {
      ...expense,
      periodId,
      createdAt,
      updatedAt: nowIso,
    }
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

  async function confirmPendingSettlement(actualAmount?: number) {
    if (!pendingSettlement) return
    const finalAmount = actualAmount && actualAmount > 0 ? actualAmount : pendingSettlement.amount
    await recordSettlement(pendingSettlement.fromMemberId, pendingSettlement.toMemberId, finalAmount, pendingSettlement.periodId)
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

  // NOTE(VI): Lý do:
  // 1. Kỳ mới bắt đầu ngay hôm nay (endDate = today()) để nếu trong ngày có chi tiêu tiếp theo thì tự động thuộc kỳ mới và có thể chốt tiếp nhiều lần trong cùng ngày.
  // 2. Trước khi thực hiện Chốt sổ, tự động đồng bộ và kéo dữ liệu mới nhất từ Cloud về kiểm tra: nếu phát hiện có khoản chi/trả tiền mới của người khác vừa thêm trên mạng mà máy chưa tải về, lập tức cập nhật lại sổ + số dư và dừng việc chốt sổ để người dùng kiểm tra lại con số chính xác trước khi chốt.
  // Trước: Bấm Chốt sổ là khóa kỳ ngay trên dữ liệu local hiện tại, có thể sót khoản chi mới của thành viên khác vừa nhập trên mạng
  // Sau: Kiểm tra dữ liệu Cloud mới nhất trước khi chốt; nếu có thay đổi từ máy khác thì cập nhật số dư mới và thông báo cho người dùng kiểm tra lại
  // Test: Máy A thêm khoản chi mới -> Máy B đang mở sẵn bấm Chốt sổ -> Máy B tự kéo khoản chi của máy A về, cập nhật lại số dư và báo "Đã cập nhật khoản chi mới từ mạng, vui lòng kiểm tra trước khi chốt sổ"
  async function closeCurrentPeriod() {
    if (!ledger || !selectedPeriod || selectedPeriod.status !== 'open') return

    if (isCloudConfigured && isOnline) {
      try {
        await processQueue()
        const remote = await fetchCloudLedger()
        const remainingQueue = await readQueue()
        const merged = remainingQueue.length ? applyPendingOperations(remote, remainingQueue) : remote
        const latestLedger = normalizeLedger(merged)

        const currentExpenseSig = ledger.expenses
          .map((e) => `${e.id}:${e.amount}:${e.updatedAt ?? ''}:${e.periodId ?? ''}`)
          .sort()
          .join('|')
        const latestExpenseSig = latestLedger.expenses
          .map((e) => `${e.id}:${e.amount}:${e.updatedAt ?? ''}:${e.periodId ?? ''}`)
          .sort()
          .join('|')
        const currentSettlementSig = ledger.settlements
          .map((s) => `${s.id}:${s.amount}:${s.updatedAt ?? ''}:${s.periodId ?? ''}`)
          .sort()
          .join('|')
        const latestSettlementSig = latestLedger.settlements
          .map((s) => `${s.id}:${s.amount}:${s.updatedAt ?? ''}:${s.periodId ?? ''}`)
          .sort()
          .join('|')
        const latestOpenPeriod = latestLedger.periods.find((p) => p.status === 'open')

        if (
          currentExpenseSig !== latestExpenseSig ||
          currentSettlementSig !== latestSettlementSig ||
          latestOpenPeriod?.id !== selectedPeriod.id
        ) {
          setLedger(latestLedger)
          await writeLedger(latestLedger)
          await refreshMonthlyTotals()
          setShowClosePeriodConfirm(false)
          if (latestOpenPeriod?.id !== selectedPeriod.id) {
            setSyncNotice('Kỳ chi tiêu này vừa được chốt trên một thiết bị khác. Dữ liệu mới nhất đã được cập nhật.')
            showToast('Kỳ này đã được chốt từ thiết bị khác')
          } else {
            setSyncNotice('Phát hiện khoản chi mới vừa được cập nhật từ mạng. Vui lòng kiểm tra lại số dư và gợi ý chuyển tiền trước khi chốt sổ.')
            showToast('Đã cập nhật khoản chi mới từ mạng')
          }
          return
        }
      } catch {
        // Nếu mạng chập chờn không kiểm tra được, tiếp tục xử lý theo hàng đợi offline
      }
    }

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
      <div className="nav-label">MENU</div><nav><button className="nav-item active"><ReceiptText size={18} strokeWidth={1.9} /><span>Sổ chi tiêu</span></button></nav>
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
        <section className="summary-grid expense-summary-grid">
            <article className="summary-card total-card"><div className="card-watermark" aria-hidden="true">₫</div><div className="summary-top"><span>Tổng chi chưa thanh toán</span><span className="summary-icon green"><Wallet size={17} /></span></div><strong>{money(unpaidTotal)}</strong></article>
            <article className="summary-card"><div className="summary-top"><span>Chi tiêu tháng này</span></div><strong>{money(thisMonth)}</strong><div ref={monthlyChartRef} className="monthly-chart" aria-label="Chi tiêu theo tháng trong 6 tháng gần nhất"><div className="mini-bars">{monthlyExpenseTotals.map((item) => {
              const barHeight = maxMonthlyExpense ? item.total / maxMonthlyExpense * 92 : 0
              return <button key={item.key} type="button" className={`month-bar ${item.isCurrent ? 'current-month' : ''} ${item.total === 0 ? 'no-data' : ''} ${selectedChartMonth === item.key ? 'selected-month' : ''}`} title={`${item.title}: ${money(item.total)}`} aria-label={`${item.title}: ${money(item.total)}`} aria-pressed={selectedChartMonth === item.key} onClick={() => setSelectedChartMonth(item.key)}><i style={{ height: `${barHeight}%` }} />{selectedChartMonth === item.key && <><b style={{ bottom: `calc(${barHeight}% + 3px)` }}>{new Intl.NumberFormat('vi-VN', { maximumFractionDigits: 1 }).format(item.total / 1000)}k</b><small>{item.label}</small></>}</button>
            })}</div></div></article>
          </section>
          {/* NOTE(VI): Lý do: Bỏ text "Các khoản chi được ghi lại theo ngày", giữ nút In bill & Lọc cùng hàng không xuống dòng, căn thẳng hàng với tiêu đề
              Trước: Có p phụ đề; nút bị co rớt chữ Lọc xuống dòng; tiêu đề bọc trong div thừa gây lệch hàng
              Sau: Tiêu đề h2 trực tiếp trong panel-heading với align-items: center; nút có thẻ span và white-space: nowrap
              Test: Xem phần Lịch sử chi tiêu -> Tiêu đề gọn gàng, căn thẳng hàng ngang tuyệt đối với 2 nút In bill và Lọc */}
          <CurrentMoneyOverview members={calculationMembers} balances={balances} />

          {/* NOTE(VI): Lý do: Gộp chức năng Chốt sổ vào ngay dưới khung Số dư hiện tại theo yêu cầu người dùng
              Trước: Phải bấm chuyển tab sang menu "Chốt sổ" riêng biệt ở thanh điều hướng dưới cùng
              Sau: Vùng Kỳ hiện tại nằm dưới Số dư, click vào sẽ xổ thông tin xuống (đẩy Lịch sử chi tiêu xuống), gồm: thông báo & nút Chốt sổ kỳ này, bảng Gợi ý chuyển tiền kèm nút Đã trả, và nút mở popup Lịch sử trả tiền
              Test: Click vào thanh "Kỳ hiện tại" -> xổ xuống thông báo, nút chốt sổ, gợi ý chuyển tiền; bấm "Chốt sổ kỳ này" -> mở popup xác nhận chốt; bấm "Xem lịch sử trả tiền" -> mở popup lịch sử trả tiền */}
          <section
            className="panel period-accordion-panel"
            onClick={() => {
              setShowSettlementSection((open) => {
                const next = !open
                if (next && isCloudConfigured && isOnline) {
                  void hydrate(true)
                }
                return next
              })
            }}
          >
            <div className="period-accordion-header">
              <div className="period-current">
                <h2>Kỳ chi tiêu hiện tại</h2>
                <span>Từ ngày <b>{selectedPeriod ? formatDate(selectedPeriod.startDate) : '—'}</b> đến nay</span>
              </div>
              <div className="period-accordion-action" style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <button
                  type="button"
                  className={`filter-button ${showSettlementSection ? 'active' : ''}`}
                  aria-expanded={showSettlementSection}
                  style={{ pointerEvents: 'none' }}
                >
                  <ChevronDown
                    size={14}
                    style={{
                      transform: showSettlementSection ? 'rotate(180deg)' : 'none',
                      transition: 'transform 0.2s ease',
                    }}
                  />
                  <span>{showSettlementSection ? 'Thu gọn' : 'Chốt sổ'}</span>
                </button>
              </div>
            </div>

            {showSettlementSection && (
              <div className="settlement-expanded-container">
                {/* 1. Thông báo & nút chốt sổ */}
                <div
                  className="settlement-notice-box"
                  onClick={(e) => e.stopPropagation()}
                >
                  <div className="settlement-notice-text">
                    <Info size={17} style={{ color: '#287b5d', flexShrink: 0, marginTop: '2px' }} />
                    {/* NOTE(VI): Lý do: Đổi lời nhắc chốt sổ theo yêu cầu người dùng
                    Trước: "Phải bấm chốt sổ để chốt kỳ tính toán này trước khi báo thanh toán cho các thành viên."
                    Sau: "Chỉ bấm chốt sổ sau khi đã xác nhận bill chính xác với các thành viên."
                    Test: Mở phần Quyết toán -> Kiểm tra hộp thông báo trước nút Chốt sổ kỳ này */}
                    <span>Chỉ bấm chốt sổ sau khi đã xác nhận bill chính xác với các thành viên.</span>
                  </div>
                  {selectedPeriod?.status === 'open' && (
                    <button
                      type="button"
                      className="button primary"
                      style={{ height: '36px', fontSize: '13px', fontWeight: 600, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '6px', width: '100%', borderRadius: '8px' }}
                      onClick={() => {
                        if (isCloudConfigured && isOnline) {
                          void hydrate(true)
                        }
                        setShowClosePeriodConfirm(true)
                      }}
                    >
                      <LockKeyhole size={15} />
                      <span>Chốt sổ kỳ này</span>
                    </button>
                  )}
                </div>

                {/* 2. Gợi ý chuyển tiền */}
                <div onClick={(e) => e.stopPropagation()}>
                  <SettlementSuggestionsPanel
                    inline
                    ledger={ledger}
                    groupName={ledger.name}
                    suggestions={suggestions}
                    members={ledger.members}
                    onRecord={(from, to, amount) => requestSettlementConfirmation(from, to, amount, ledger.periods.find((period) => period.status === 'open')?.id ?? '')}
                  />
                </div>

                {/* 3. Nút xem Lịch sử chuyển tiền */}
                <div onClick={(e) => e.stopPropagation()}>
                  <button
                    type="button"
                    className="button secondary"
                    style={{ height: '36px', fontSize: '13px', fontWeight: 600, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '7px', width: '100%', background: '#fff', border: '1px solid #e0e4dd', borderRadius: '8px' }}
                    onClick={() => setShowSettlementHistoryModal(true)}
                  >
                    <History size={15} />
                    <span>Lịch sử trả tiền {orderedSettlements.length > 0 ? `(${orderedSettlements.length})` : ''}</span>
                  </button>
                </div>
              </div>
            )}
          </section>

          <section className="panel full-panel">
            <div className="panel-heading"><h2>Lịch sử chi tiêu</h2><div className="expense-panel-actions"><button type="button" className="filter-button" onClick={() => setShowBillModal(true)}><Printer size={14} /><span>In bill</span></button><button type="button" className={`filter-button ${showExpenseFilters ? 'active' : ''}`} aria-expanded={showExpenseFilters} onClick={() => setShowExpenseFilters((open) => !open)}><Filter size={14} /><span>Lọc</span>{activeFilterCount > 0 && <span className="filter-badge">{activeFilterCount}</span>}</button></div></div>
            {showExpenseFilters && <div className="expense-filters"><div className="expense-filter-fields">
              <label style={{ gridColumn: 'span 2' }}>Kỳ chốt sổ
                <select value={expenseFilters.periodId} onChange={(event) => setExpenseFilters({ ...expenseFilters, periodId: event.target.value })}>
                  <option value="">Kỳ hiện tại & kỳ vừa chốt (mặc định)</option>
                  <option value="all">Tất cả các kỳ</option>
                  {openPeriod && <option value={openPeriod.id}>Kỳ hiện tại (từ {formatDate(openPeriod.startDate)} đến nay)</option>}
                  {closedPeriods.map((period, index) => (
                    <option key={period.id} value={period.id}>
                      {index === 0 ? 'Kỳ vừa chốt: ' : ''}{period.endDate ? `Kỳ ${formatDate(period.startDate)} – ${formatDate(period.endDate)}` : `Kỳ từ ${formatDate(period.startDate)}`} (Đã chốt)
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
            {/* NOTE(VI): Lý do: Giữ nguyên quy tắc khi thêm mới (khoản thêm mới đưa lên đầu ngày/ngày mới), nhưng khi sửa khoản chi thì giữ nguyên vị trí cũ không đưa lên đầu theo yêu cầu người dùng
                Trước: Sắp xếp theo b.updatedAt -> khi sửa khoản chi thì updatedAt đổi mới nhất, làm khoản đó nhảy lên đầu danh sách
                Sau: Sắp xếp theo b.date desc rồi đến (b.createdAt ?? b.updatedAt ?? '') desc -> khi thêm mới có createdAt mới nhất nên vẫn lên đầu; khi sửa thì createdAt giữ nguyên vị trí ban đầu không bị nhảy
                Test: Thêm khoản chi mới -> hiển thị trên cùng; bấm Sửa 1 khoản chi ở giữa danh sách và Lưu -> khoản chi vẫn đứng yên đúng vị trí đó */}
            <ExpenseList key={JSON.stringify(expenseFilters)} expenses={[...filteredExpenses].sort((a, b) => b.date.localeCompare(a.date) || (b.createdAt ?? b.updatedAt ?? '').localeCompare(a.createdAt ?? a.updatedAt ?? '') || b.id.localeCompare(a.id))} members={ledger.members} periods={ledger.periods} onEdit={(expense) => { setEditing(expense); setModal('expense') }} onDelete={(expense) => void deleteExpense(expense)} onView={(expense) => setViewingExpense(expense)} emptyText={activeFilterCount ? 'Không tìm thấy khoản chi phù hợp với bộ lọc.' : (ledger.expenses.length ? 'Chưa có khoản chi nào trong kỳ này và kỳ vừa chốt.' : 'Chưa có khoản chi nào. Thêm khoản chi đầu tiên nhé.')} />
          </section>

      </div>
    </main>

    {modal === 'expense' && (
      <ExpenseModal
        members={activeMembers}
        initial={editing}
        lastExpenseMemberIds={[...ledger.expenses]
          .sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '') || b.date.localeCompare(a.date))[0]
          ?.splits.filter((s) => s.amount > 0)
          .map((s) => s.memberId)}
        minDate={ledger.periods.find((period) => period.id === (editing?.periodId ?? ledger.periods.find((item) => item.status === 'open')?.id))?.startDate}
        onClose={() => { setModal(null); setEditing(null) }}
        onSave={(expense) => void saveExpense(expense, editing ?? undefined)}
      />
    )}
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
    {showBillModal && <BillModal groupName={ledger.name} expenses={billData.expenses} members={ledger.members} subtitle={billData.subtitle} ledger={ledger} onClose={() => setShowBillModal(false)} showToast={showToast} />}
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
      onLogout={() => {
        try { localStorage.removeItem('chia-tien-offline-email') } catch {}
        setShowAccount(false)
        void signOut()
      }}
    />}
    {showSettlementHistoryModal && (
      <SettlementHistoryModal
        members={ledger.members}
        settlements={periodSettlements}
        filteredSettlements={filteredSettlements}
        visibleSettlements={visibleSettlements}
        displaySettlements={displaySettlements}
        safeSettlementPage={safeSettlementPage}
        settlementPageCount={settlementPageCount}
        hasSettlementFilter={hasSettlementFilter}
        settlementFilters={settlementFilters}
        showSettlementFilters={showSettlementFilters}
        onToggleFilters={() => setShowSettlementFilters((open) => !open)}
        onFilterChange={(filters) => {
          setSettlementFilters(filters)
          setSettlementHistoryPage(1)
        }}
        onClearFilters={() => {
          setSettlementFilters({ fromDate: '', toDate: '', memberId: '' })
          setSettlementHistoryPage(1)
        }}
        onPageChange={setSettlementHistoryPage}
        onDeleteSettlement={(settlement) => setPendingSettlementDelete(settlement)}
        onClose={() => setShowSettlementHistoryModal(false)}
      />
    )}
  </div>
    {/* NOTE(VI): Lý do: Gộp menu Chốt sổ vào màn hình chính nên nút nổi chỉ dành cho chức năng Thêm khoản chi; nút Chốt sổ đã đưa vào vùng kỳ hiện tại
        Trước: Đổi nút nổi giữa Thêm khoản chi và Chốt sổ theo tab
        Sau: Luôn hiển thị nút Thêm khoản chi ở góc dưới phải
        Test: Kiểm tra góc dưới phải luôn hiển thị nút Thêm khoản chi */}
    <button
      type="button"
      className="button primary floating-add-expense"
      aria-label="Thêm khoản chi"
      title="Thêm khoản chi"
      onClick={() => {
        setEditing(null)
        setModal('expense')
      }}
    >
      <Plus size={18} />
      <span>Thêm khoản chi</span>
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
  return <div className="pagination-controls"><span>{first} – {last} / {total}</span><div><button disabled={page <= 1} aria-label="Trang trước" onClick={() => onPageChange(page - 1)}><ChevronLeft size={16} /></button><span>{page} / {pageCount}</span><button disabled={page >= pageCount} aria-label="Trang sau" onClick={() => onPageChange(page + 1)}><ChevronRight size={16} /></button></div></div>
}

// NOTE(VI): Lý do: Tinh chỉnh lại UI Bill theo yêu cầu người dùng:
// 1. Đầu bill: Bỏ text "SỔ CHI TIÊU NHÓM" và "SỔ CHI TIÊU NHÓM MÌNH", bắt đầu ngay từ "PHIẾU THANH TOÁN"
// 2. Chi tiết từng khoản: Bỏ dòng "Chia đều" hoặc "Tùy chỉnh số tiền", nếu chia đều chỉ ghi tên thành viên, nếu chia theo % hoặc tiền thì ghi thẳng [Tên]: % hoặc số tiền
// 3. Nút bấm: Bỏ nút "Tải ảnh PNG", đưa nút "Sao chép ảnh bill" cùng hàng với "Copy text" và "Đóng", giữ nguyên màu xanh var(--green)
// 4. Mã QR: Cập nhật hình ảnh mã QR ngân hàng Techcombank gọn gàng, giữ nguyên toàn bộ thông tin tài khoản
// 5. Cuối bill: Bỏ phần cảm ơn và mã vạch gạch đứng, bill kết thúc gọn gàng ngay sau mã QR
// Test: Mở Bill -> Thấy bill gọn sạch chuẩn phiếu in nhiệt, các đường gạch đứt sắc nét, 3 nút bấm nằm thẳng 1 hàng; bấm "Sao chép ảnh bill" rồi dán vào Zalo/Messenger hiển thị ảnh hoàn chỉnh
function BillModal({
  groupName: _groupName,
  expenses,
  members,
  subtitle = 'Tổng hợp các khoản chi.',
  ledger,
  onClose,
  showToast,
}: {
  groupName: string
  expenses: Expense[]
  members: Member[]
  subtitle?: string
  ledger?: Ledger
  onClose: () => void
  showToast?: (msg: string) => void
}) {
  const [copiedText, setCopiedText] = useState(false)
  const [downloadingChunks, setDownloadingChunks] = useState(false)
  const [downloadProgress, setDownloadProgress] = useState('')
  const [downloadedChunks, setDownloadedChunks] = useState(false)
  const receiptRef = useRef<HTMLDivElement>(null)
  const chunkRefs = useRef<(HTMLDivElement | null)[]>([])

  const total = expenses.reduce((sum, expense) => sum + expense.amount, 0)
  const memberName = (id: string) => members.find((member) => member.id === id)?.name ?? 'Thành viên'

  // NOTE(VI): Lý do: Cắt danh sách khoản chi thành từng nhóm tối đa 10 hóa đơn/ảnh theo yêu cầu người dùng
  // Trước: Toàn bộ khoản chi nằm trên 1 ảnh dài duy nhất, nếu nhiều hóa đơn (ví dụ 45) thì ảnh rất dài và zoom khó đọc
  // Sau: Tách mảng 10 phần tử: Phần 1 (đầu bill + 10 khoản đầu), các phần giữa (10 khoản tiếp theo), phần cuối (các khoản còn lại + tổng kết, phân chia & QR)
  // Test: Tạo 15 hoặc 45 khoản chi -> kiểm tra mảng chunks chia đúng 2 hoặc 5 phần, mỗi phần tối đa 10 khoản
  const CHUNK_SIZE = 10
  const expenseChunks = useMemo(() => {
    if (!expenses.length) return []
    const chunks: Expense[][] = []
    for (let i = 0; i < expenses.length; i += CHUNK_SIZE) {
      chunks.push(expenses.slice(i, i + CHUNK_SIZE))
    }
    return chunks
  }, [expenses])

  // NOTE(VI): Lý do: Tách Trang 1 thành riêng trang Thông tin thanh toán (Header + Số tiền cần chuyển + QR code),
  // các trang tiếp theo chứa danh sách khoản chi (mỗi trang 10 khoản, trang cuối có Tổng tiền + Phân chia).
  // Trước: Trang 1 nhét cả Thông tin thanh toán lẫn 10 khoản chi đầu tiên
  // Sau: Trang 1 chỉ gồm đầu bill đến hết "Quét mã VietQR trên app ngân hàng để chuyển khoản nhanh", Trang 2 trở đi là danh sách khoản chi
  // Test: Bấm "Tải ảnh cắt gọn" -> Trang 1 xuất ra ảnh Thông tin thanh toán & QR, Trang 2 xuất ra 10 khoản chi đầu
  const totalSheets = expenseChunks.length > 0 ? 1 + expenseChunks.length : 1

  const dateGroups = expenses.reduce<{ date: string; expenses: Expense[] }[]>((groups, expense) => {
    const current = groups[groups.length - 1]
    if (current?.date === expense.date) current.expenses.push(expense)
    else groups.push({ date: expense.date, expenses: [expense] })
    return groups
  }, [])

  // Bảng phân chia theo từng người trong các khoản chi của bill
  const memberBreakdown = useMemo(() => {
    const shareMap = new Map<string, number>()
    const paidMap = new Map<string, number>()
    for (const exp of expenses) {
      paidMap.set(exp.payerId, (paidMap.get(exp.payerId) || 0) + exp.amount)
      for (const split of exp.splits) {
        if (split.amount > 0) {
          shareMap.set(split.memberId, (shareMap.get(split.memberId) || 0) + split.amount)
        }
      }
    }
    return members
      .map((m) => ({
        id: m.id,
        name: m.name,
        share: shareMap.get(m.id) || 0,
        paid: paidMap.get(m.id) || 0,
      }))
      .filter((item) => item.share > 0 || item.paid > 0)
      .sort((a, b) => b.share - a.share)
  }, [expenses, members])

  // NOTE(VI): Lý do: Bổ sung gợi ý số tiền cần chuyển vào mục "SỐ TIỀN CẦN CHUYỂN" ngay trên bill theo yêu cầu người dùng
  // Trước: Bill chỉ có danh sách chi tiêu và bảng chia tiền từng người ở cuối, không có gợi ý rõ người nào cần chuyển cho ai
  // Sau: Tự động tính toán số tiền cần chuyển (Ai trả ai bao nhiêu) và đặt ngay trước mục Thông tin chuyển khoản ở đầu bill
  // Test: Mở bill -> Thấy rõ mục "SỐ TIỀN CẦN CHUYỂN" (ví dụ: Kha trả Thương: 183.000 đ) ngay trên khung mã QR
  const transferSuggestions = useMemo(() => {
    const creditors = memberBreakdown
      .map((m) => ({ memberId: m.id, name: m.name, amount: m.paid - m.share }))
      .filter((x) => x.amount > 0)
      .sort((a, b) => b.amount - a.amount)
    const debtors = memberBreakdown
      .map((m) => ({ memberId: m.id, name: m.name, amount: m.share - m.paid }))
      .filter((x) => x.amount > 0)
      .sort((a, b) => b.amount - a.amount)

    const list: { fromName: string; toName: string; amount: number; note?: string }[] = []
    let d = 0
    let c = 0
    const dList = debtors.map((x) => ({ ...x }))
    const cList = creditors.map((x) => ({ ...x }))
    while (d < dList.length && c < cList.length) {
      const amount = Math.min(dList[d].amount, cList[c].amount)
      if (amount > 0) {
        const breakdown = ledger ? getMemberDebtBreakdown(ledger, dList[d].memberId) : { note: '' }
        list.push({ fromName: dList[d].name, toName: cList[c].name, amount, note: breakdown.note ?? undefined })
      }
      dList[d].amount -= amount
      cList[c].amount -= amount
      if (dList[d].amount <= 0) d++
      if (cList[c].amount <= 0) c++
    }
    return list
  }, [memberBreakdown, ledger])

  const billText = useMemo(() => {
    return [
      `----------------------------------------`,
      `          PHIẾU THANH TOÁN`,
      `----------------------------------------`,
      ...(subtitle ? [`Kỳ: ${subtitle}`] : []),
      `Ngày lập : ${formatDate(today())}`,
      `Tổng chi : ${money(total)} (${expenses.length} khoản)`,
      `----------------------------------------`,
      `SỐ TIỀN CẦN CHUYỂN:`,
      ...(transferSuggestions.length
        ? transferSuggestions.map((s) => `• ${s.fromName} chuyển ${s.toName}: ${money(s.amount)}${s.note ? ` (${s.note})` : ''}`)
        : [`• Đã cân bằng số dư (0 đ)`]),
      `----------------------------------------`,
      `THÔNG TIN CHUYỂN KHOẢN:`,
      `Ngân hàng : TECHCOMBANK`,
      `Chủ TK    : LE THI LY THUONG`,
      `Số TK     : 1903 8123 1750 16`,
      `----------------------------------------`,
      `DANH SÁCH KHOẢN CHI:`,
      ...dateGroups.flatMap((group) => [
        `\n[ ${formatDate(group.date)} ]`,
        ...group.expenses.flatMap((expense, idx) => {
          const splits = expense.splits.filter((s) => s.amount > 0)
          let splitDesc = ''
          if (expense.splitMode === 'equal') {
            splitDesc = `   Chia cho  : ${splits.map((s) => memberName(s.memberId)).join(', ')}`
          } else if (expense.splitMode === 'percent') {
            splitDesc = `   Tỷ lệ chia: ` + splits.map((s) => `${memberName(s.memberId)}: ${new Intl.NumberFormat('vi-VN', { maximumFractionDigits: 1 }).format((s.amount / (expense.amount || 1)) * 100)}% (${money(s.amount)})`).join(' · ')
          } else {
            splitDesc = `   Tiền chia : ` + splits.map((s) => `${memberName(s.memberId)}: ${money(s.amount)}`).join(' · ')
          }
          return [
            `${String(idx + 1).padStart(2, '0')}. ${expense.title} : ${money(expense.amount)}`,
            `   Người trả : ${memberName(expense.payerId)}`,
            splitDesc,
            ...(expense.note ? [`   Ghi chú   : ${expense.note}`] : []),
          ]
        }),
      ]),
      `----------------------------------------`,
      `Số lượng : ${expenses.length} khoản chi`,
      `TỔNG CỘNG: ${money(total)}`,
      `----------------------------------------`,
      `PHẦN PHẢI CHI TRẢ TỪNG NGƯỜI:`,
      ...memberBreakdown.map((m) => `• ${m.name}: ${money(m.share)}${m.paid > 0 ? ` (Đã chi trước: ${money(m.paid)})` : ''}`),
      `----------------------------------------`,
    ].join('\n')
  }, [subtitle, expenses, total, dateGroups, memberBreakdown, transferSuggestions])

  async function prepareReceiptRenderOptions(node: HTMLElement) {
    const imgs = Array.from(node.querySelectorAll('img'))
    await Promise.all(
      imgs.map(async (img) => {
        if (!img.complete) {
          await new Promise<void>((resolve) => {
            img.onload = () => resolve()
            img.onerror = () => resolve()
          })
        }
        if (img.decode) {
          try {
            await img.decode()
          } catch {
            // ignore decode error
          }
        }
      })
    )

    const width = Math.max(
      node.scrollWidth,
      node.offsetWidth,
      Math.ceil(node.getBoundingClientRect().width),
      360
    )
    const height = Math.max(
      node.scrollHeight,
      node.offsetHeight,
      Math.ceil(node.getBoundingClientRect().height)
    )

    return {
      pixelRatio: 2.5,
      backgroundColor: '#ffffff',
      cacheBust: false,
      width,
      height,
      canvasWidth: width,
      canvasHeight: height,
      style: {
        transform: 'none',
        maxHeight: 'none',
        height: `${height}px`,
        width: `${width}px`,
        overflow: 'visible',
        margin: '0',
        border: 'none',
        boxShadow: 'none',
        borderRadius: '0',
      },
    }
  }

  async function copyTextFallback() {
    try {
      await navigator.clipboard.writeText(billText)
      setCopiedText(true)
      showToast?.('Đã sao chép văn bản bill')
    } catch {
      const textArea = document.createElement('textarea')
      textArea.value = billText
      textArea.style.position = 'fixed'
      textArea.style.opacity = '0'
      document.body.appendChild(textArea)
      textArea.select()
      const success = document.execCommand('copy')
      textArea.remove()
      setCopiedText(success)
      showToast?.(success ? 'Đã sao chép văn bản bill' : 'Không thể sao chép văn bản')
    }
    window.setTimeout(() => setCopiedText(false), 2200)
  }

  // NOTE(VI): Lý do: Khắc phục triệt để lỗi WebKit (Safari trên iPhone/iOS) không vẽ ảnh thẻ <img> bên trong SVG <foreignObject> khi xuất canvas
  // Trên iOS Safari, WebKit sandbox chặn hoàn toàn các thẻ <img> hoặc raster data bên trong foreignObject khi vẽ lên Canvas, khiến ảnh bill tải về bị mất mã QR (chỉ còn khung nét đứt trắng).
  // Giải pháp: Dùng toCanvas để xuất canvas layout gốc, sau đó dùng 2D Context (ctx.drawImage) vẽ đè mã QR VietQR Techcombank trực tiếp lên tọa độ khung QR trên canvas.
  // Trước: Dùng toBlob() -> tải bill về trên iPhone bị mất mã QR
  // Sau: toCanvas() + ctx.drawImage() trực tiếp -> ảnh QR hiển thị 100% đầy đủ, rõ nét trên cả iPhone, Android và máy tính
  // Test: Bấm "Tải ảnh bill" -> Mở ảnh phần 1 -> Thấy mã QR Techcombank LE THI LY THUONG hiển thị rõ nét bên trong khung viền
  async function renderReceiptNodeToBlob(node: HTMLElement): Promise<Blob> {
    const options = await prepareReceiptRenderOptions(node)
    const canvas = await toCanvas(node, options)

    const qrEl = node.querySelector('.receipt-qr-code') as HTMLElement | null
    if (qrEl) {
      try {
        const width = options.width || 375
        const height = options.height || 600

        // Đo tọa độ phần tử QR tương đối so với thẻ cha node
        let relTop = 0
        let relLeft = 0
        let curr: HTMLElement | null = qrEl
        while (curr && curr !== node) {
          relTop += curr.offsetTop
          relLeft += curr.offsetLeft
          curr = curr.offsetParent as HTMLElement | null
        }

        // Bổ trợ độ chính xác bằng getBoundingClientRect
        const qrRect = qrEl.getBoundingClientRect()
        const nodeRect = node.getBoundingClientRect()
        if (nodeRect.width > 0 && qrRect.width > 0) {
          const gRelLeft = qrRect.left - nodeRect.left
          const gRelTop = qrRect.top - nodeRect.top
          if (!isNaN(gRelLeft) && gRelLeft >= 0 && gRelLeft < width) {
            relLeft = gRelLeft
          }
          if (!isNaN(gRelTop) && gRelTop >= 0 && gRelTop < height) {
            relTop = gRelTop
          }
        }

        const qrWidth = qrEl.offsetWidth || qrRect.width || 165
        const qrHeight = qrEl.offsetHeight || qrRect.height || 165

        // Đọc padding và border để vẽ chính xác vào lòng trong của khung viền nét đứt
        const compStyle = window.getComputedStyle(qrEl)
        const padLeft = parseFloat(compStyle.paddingLeft) || 4
        const padTop = parseFloat(compStyle.paddingTop) || 4
        const padRight = parseFloat(compStyle.paddingRight) || 4
        const padBottom = parseFloat(compStyle.paddingBottom) || 4
        const borderLeft = parseFloat(compStyle.borderLeftWidth) || 1
        const borderTop = parseFloat(compStyle.borderTopWidth) || 1
        const borderRight = parseFloat(compStyle.borderRightWidth) || 1
        const borderBottom = parseFloat(compStyle.borderBottomWidth) || 1

        const insetLeft = borderLeft + padLeft
        const insetTop = borderTop + padTop
        const innerW = Math.max(20, qrWidth - insetLeft - borderRight - padRight)
        const innerH = Math.max(20, qrHeight - insetTop - borderBottom - padBottom)

        const fallbackX = Math.max(0, (width - qrWidth) / 2)
        const safeRelLeft = (!isNaN(relLeft) && relLeft >= 0 && relLeft < width) ? relLeft : fallbackX
        const safeRelTop = (!isNaN(relTop) && relTop >= 0 && relTop < height) ? relTop : 200

        const scaleX = canvas.width / width
        const scaleY = canvas.height / height

        const destX = (safeRelLeft + insetLeft) * scaleX
        const destY = (safeRelTop + insetTop) * scaleY
        const destW = innerW * scaleX
        const destH = innerH * scaleY

        const ctx = canvas.getContext('2d')
        if (ctx) {
          const qrImg = new Image()
          qrImg.src = QR_PAYMENT_DATA_URL
          if (qrImg.decode) {
            try {
              await qrImg.decode()
            } catch {
              // ignore decode error
            }
          }
          if (!qrImg.complete) {
            await new Promise<void>((resolve) => {
              qrImg.onload = () => resolve()
              qrImg.onerror = () => resolve()
            })
          }
          const radius = Math.max(0, 4 * scaleX)
          ctx.save()
          ctx.beginPath()
          if (typeof ctx.roundRect === 'function') {
            ctx.roundRect(destX, destY, destW, destH, radius)
          } else {
            ctx.rect(destX, destY, destW, destH)
          }
          ctx.clip()
          ctx.drawImage(qrImg, destX, destY, destW, destH)
          ctx.restore()
        }
      } catch (err) {
        console.warn('Lỗi vẽ QR code trực tiếp lên canvas:', err)
      }
    }

    return new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (blob) {
          resolve(blob)
        } else {
          try {
            const dataUrl = canvas.toDataURL('image/png')
            const byteString = atob(dataUrl.split(',')[1])
            const ab = new ArrayBuffer(byteString.length)
            const ia = new Uint8Array(ab)
            for (let k = 0; k < byteString.length; k++) {
              ia[k] = byteString.charCodeAt(k)
            }
            resolve(new Blob([ia], { type: 'image/png' }))
          } catch (e) {
            reject(e)
          }
        }
      }, 'image/png')
    })
  }

  // NOTE(VI): Lý do: Khắc phục triệt để lỗi trên iPhone (iOS Safari) chỉ tải được 1 ảnh và văng ra màn hình đen AnyDesk/QuickLook
  // Tách Trang 1 thành riêng trang Thông tin thanh toán (Header + Số tiền cần chuyển + QR code),
  // các trang tiếp theo chứa danh sách khoản chi (mỗi trang 10 khoản, trang cuối có Tổng tiền + Phân chia).
  // Trước: Trang 1 nhét cả Thông tin thanh toán lẫn 10 khoản chi đầu tiên
  // Sau: Trang 1 chỉ gồm đầu bill đến hết "Quét mã VietQR trên app ngân hàng để chuyển khoản nhanh", Trang 2 trở đi là danh sách khoản chi
  // Test: Bấm "Tải ảnh bill" -> Trang 1 xuất ra ảnh Thông tin thanh toán & QR, Trang 2 xuất ra 10 khoản chi đầu
  async function downloadChunkedImages() {
    if (!expenses.length) return
    setDownloadingChunks(true)
    try {
      const totalSheets = expenseChunks.length > 0 ? 1 + expenseChunks.length : 1
      const generatedFiles: { name: string; blob: Blob; file: File; url: string }[] = []
      const dateStr = today().replace(/-/g, '')

      for (let i = 0; i < totalSheets; i++) {
        setDownloadProgress(`Đang tạo (${i + 1}/${totalSheets})...`)
        const node = chunkRefs.current[i]
        if (!node) continue

        const blob = await renderReceiptNodeToBlob(node)
        if (!blob) throw new Error(`Không tạo được ảnh phần ${i + 1}`)

        const filename = totalSheets > 1
          ? `bill-${dateStr}-phan-${i + 1}-cua-${totalSheets}.png`
          : `bill-${dateStr}.png`

        const file = new File([blob], filename, { type: 'image/png' })
        const url = URL.createObjectURL(blob)
        generatedFiles.push({ name: filename, blob, file, url })
      }

      if (totalSheets === 1) {
        const single = generatedFiles[0]
        if (single) {
          if (typeof navigator !== 'undefined' && typeof navigator.canShare === 'function' && navigator.canShare({ files: [single.file] })) {
            try {
              await navigator.share({
                files: [single.file],
                title: 'Phiếu thanh toán',
              })
              setDownloadedChunks(true)
              showToast?.('Đã mở bảng lưu / chia sẻ ảnh bill!')
              return
            } catch (e: unknown) {
              if (e instanceof Error && e.name === 'AbortError') return
            }
          }
          const a = document.createElement('a')
          a.href = single.url
          a.download = single.name
          document.body.appendChild(a)
          a.click()
          document.body.removeChild(a)
          setDownloadedChunks(true)
          showToast?.('Đã tải về ảnh bill!')
        }
        return
      }

      const filesToShare = generatedFiles.map((f) => f.file)

      // Trên thiết bị hỗ trợ navigator.share (iPhone, iPad, Android): Mở bảng chia sẻ hệ thống với trọn bộ ảnh
      if (typeof navigator !== 'undefined' && typeof navigator.canShare === 'function' && navigator.canShare({ files: filesToShare })) {
        try {
          await navigator.share({
            files: filesToShare,
            title: `Phiếu thanh toán (${totalSheets} ảnh)`,
            text: subtitle || 'Phiếu thanh toán chi tiêu',
          })
          setDownloadedChunks(true)
          showToast?.(`Đã mở bảng lưu / gửi cả ${totalSheets} ảnh bill!`)
          return
        } catch (err: unknown) {
          if (err instanceof Error && err.name === 'AbortError') {
            return
          }
        }
      }

      // Trình duyệt không hỗ trợ share nhiều file (PC hoặc trình duyệt khác): Tự động nén ZIP và tải về
      setDownloadProgress('Đang nén file ZIP...')
      const zip = new JSZip()
      for (const item of generatedFiles) {
        zip.file(item.name, item.blob)
      }
      const zipBlob = await zip.generateAsync({ type: 'blob' })
      const zipFilename = `bill-${dateStr}-tron-bo-${totalSheets}-anh.zip`
      const zipUrl = URL.createObjectURL(zipBlob)
      const a = document.createElement('a')
      a.href = zipUrl
      a.download = zipFilename
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      setTimeout(() => URL.revokeObjectURL(zipUrl), 15000)

      setDownloadedChunks(true)
      showToast?.(`Đã tải về file ZIP trọn bộ ${totalSheets} ảnh!`)
    } catch (err) {
      console.error('Lỗi khi xuất ảnh cắt gọn:', err)
      showToast?.('Không thể xuất ảnh cắt gọn, vui lòng thử lại.')
    } finally {
      setDownloadingChunks(false)
      setDownloadProgress('')
    }
  }

  return (
    <Modal centered wide className="bill-modal" eyebrow="PHIẾU THANH TOÁN" title="Hóa đơn chi tiêu" subtitle={subtitle} onClose={onClose}>
      <div className="bill-preview-wrapper">
        <div ref={receiptRef} className="thermal-receipt-paper bill-printable">
          {/* Header phong cách bill siêu thị / in nhiệt - Đã bỏ SỔ CHI TIÊU NHÓM và Tên nhóm */}
          <div className="receipt-header">
            <div className="receipt-doc-name">PHIẾU THANH TOÁN</div>
            {subtitle && <div className="receipt-subtitle">{subtitle}</div>}
            <div className="receipt-meta">Ngày tính: {formatDate(today())}</div>
          </div>

          <div className="receipt-divider" />

          {/* NOTE(VI): Lý do: Bổ sung thông tin tổng số tiền đã chi tiêu kỳ này vào đầu bill theo yêu cầu người dùng
              Trước: Đầu bill chỉ có ngày tính rồi đến số tiền cần chuyển, không thấy tổng tiền chi cả kỳ
              Sau: Thêm khung Tổng chi tiêu kỳ này (số lượng khoản chi + tổng tiền) ngay sau ngày tính
              Test: Mở bill -> Thấy rõ TỔNG CHI TIÊU KỲ NÀY nổi bật ngay phía trên Số tiền cần chuyển */}
          <div className="receipt-summary-block">
            <div className="receipt-summary-line">
              <span>Số lượng khoản chi:</span>
              <b>{expenses.length} khoản</b>
            </div>
            <div className="receipt-total-line">
              <span>TỔNG CHI TIÊU KỲ NÀY:</span>
              <strong className="receipt-grand-total">{money(total)}</strong>
            </div>
          </div>

          <div className="receipt-divider light" />

          {/* NOTE(VI): Lý do: Thêm mục SỐ TIỀN CẦN CHUYỂN và đưa THÔNG TIN CHUYỂN KHOẢN lên đầu bill theo yêu cầu người dùng
              Trước: Thông tin chuyển khoản nằm ở cuối bill; không có mục gợi ý số tiền cần chuyển ở đầu bill
              Sau: Đưa Số tiền cần chuyển và Thông tin chuyển khoản (kèm QR) lên ngay sau Ngày tính và trước Danh sách khoản chi
              Test: Mở bill -> Thấy ngay Số tiền cần chuyển (ai trả ai bao nhiêu) và Khung QR chuyển khoản ở phía trên */}
          <div className="receipt-section-title">SỐ TIỀN CẦN CHUYỂN</div>
          {transferSuggestions.length > 0 ? (
            <div className="receipt-transfer-list">
              {transferSuggestions.map((s, idx) => (
                <div key={idx} className="receipt-transfer-row">
                  <span className="receipt-transfer-names">
                    • <b>{s.fromName}</b> chuyển <b>{s.toName}</b>:
                    {s.note && <small className="receipt-transfer-note">{s.note}</small>}
                  </span>
                  <strong className="receipt-transfer-amount">{money(s.amount)}</strong>
                </div>
              ))}
            </div>
          ) : (
            <div className="receipt-transfer-empty">Đã cân bằng số dư (0 đ)</div>
          )}

          <div className="receipt-divider light" />

          {/* Mục chuyển khoản & Mã VietQR của LE THI LY THUONG - Đưa lên đầu bill */}
          <div className="receipt-payment-section">
            <div className="receipt-section-title">THÔNG TIN CHUYỂN KHOẢN</div>
            <div className="receipt-bank-card">
              <div>Ngân hàng: <b>TECHCOMBANK</b></div>
              <div>Chủ tài khoản: <b>LE THI LY THUONG</b></div>
              <div>Số tài khoản: <b className="receipt-account-number">1903 8123 1750 16</b></div>
            </div>

            <div className="receipt-qr-wrap">
              <img
                src={QR_PAYMENT_DATA_URL}
                alt="Mã QR Chuyển tiền Techcombank - LE THI LY THUONG"
                className="receipt-qr-code"
              />
              <div className="receipt-qr-hint">
                Quét mã VietQR trên app ngân hàng để chuyển khoản nhanh
              </div>
            </div>
          </div>

          <div className="receipt-divider" />

          {/* Danh mục chi tiết các khoản chi */}
          <div className="receipt-section-title">DANH SÁCH KHOẢN CHI</div>
          <div className="receipt-table-header">
            <span>TÊN KHOẢN CHI</span>
            <span>TIỀN (VNĐ)</span>
          </div>
          <div className="receipt-divider light" />

          {dateGroups.length ? (
            dateGroups.map((group) => (
              <div key={group.date} className="receipt-date-block">
                <div className="receipt-date-label">📅 {formatDate(group.date)}</div>
                {group.expenses.map((expense) => {
                  const globalIdx = expenses.indexOf(expense) + 1
                  const splits = expense.splits.filter((s) => s.amount > 0)
                  return (
                    <div key={expense.id} className="receipt-item-row">
                      <div className="receipt-item-main">
                        <span className="receipt-item-title">
                          <b>{String(globalIdx).padStart(2, '0')}.</b> {expense.title}
                        </span>
                        <strong className="receipt-item-amount">{money(expense.amount)}</strong>
                      </div>
                      <div className="receipt-item-sub">
                        <span>Người trả: <b>{memberName(expense.payerId)}</b></span>
                      </div>
                      {/* Thể hiện chi tiết: nếu chia đều chỉ ghi tên, nếu % hoặc tiền ghi thẳng tên: % hoặc tiền */}
                      <div className="receipt-item-split-box">
                        {expense.splitMode === 'equal' ? (
                          <div className="receipt-split-names">
                            {splits.map((s) => memberName(s.memberId)).join(', ')}
                          </div>
                        ) : expense.splitMode === 'percent' ? (
                          <div className="receipt-split-detail-list">
                            {splits.map((s) => {
                              const pct = expense.amount > 0 ? ((s.amount / expense.amount) * 100).toFixed(1).replace('.0', '') : '0'
                              return (
                                <span key={s.memberId} className="receipt-split-chip">
                                  {memberName(s.memberId)}: <b>{pct}%</b> ({money(s.amount)})
                                </span>
                              )
                            })}
                          </div>
                        ) : (
                          <div className="receipt-split-detail-list">
                            {splits.map((s) => (
                              <span key={s.memberId} className="receipt-split-chip">
                                {memberName(s.memberId)}: <b>{money(s.amount)}</b>
                              </span>
                            ))}
                          </div>
                        )}
                        {expense.note && (
                          <div className="receipt-item-note">Ghi chú: {expense.note}</div>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
            ))
          ) : (
            <div className="receipt-empty">Không có khoản chi nào trong kỳ này.</div>
          )}

          <div className="receipt-divider double" />

          {/* Tổng kết tiền */}
          <div className="receipt-summary-block">
            <div className="receipt-summary-line">
              <span>Số lượng khoản chi:</span>
              <b>{expenses.length} khoản</b>
            </div>
            <div className="receipt-total-line">
              <span>TỔNG TIỀN:</span>
              <strong className="receipt-grand-total">{money(total)}</strong>
            </div>
          </div>

          <div className="receipt-divider" />

          {/* Bảng phân chia theo từng người trong nhóm */}
          <div className="receipt-section-title">PHẦN PHẢI CHI TRẢ TỪNG NGƯỜI</div>
          <div className="receipt-breakdown-list">
            {memberBreakdown.map((m) => (
              <div key={m.id} className="receipt-breakdown-row">
                <span className="receipt-member-name">• {m.name}</span>
                <div className="receipt-member-amounts">
                  <strong>{money(m.share)}</strong>
                  {m.paid > 0 && <small>Đã chi: {money(m.paid)}</small>}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* NOTE(VI): Lý do: Bỏ nút "Sao chép ảnh bill", đổi nút "Tải ảnh cắt gọn" thành "Tải ảnh bill" màu xanh primary theo yêu cầu người dùng
          Trước: Có 2 nút tải/sao chép ảnh (Sao chép ảnh bill màu xanh, Tải ảnh cắt gọn màu trắng)
          Sau: Chỉ còn 1 nút "Tải ảnh bill" màu xanh var(--green) nổi bật làm nút hành động chính, cùng với Copy text và Đóng
          Test: Mở popup In bill -> Thấy chỉ còn 3 nút, nút Tải ảnh bill màu xanh ở đầu hàng; bấm tải hoạt động chuẩn */}
      <div className="modal-actions bill-actions-row">
        <button
          type="button"
          className="button primary bill-download-chunk-btn"
          disabled={downloadingChunks || !expenses.length}
          onClick={() => void downloadChunkedImages()}
          title="Tải ảnh bill về máy để gửi lên nhóm chat hoặc lưu trữ"
        >
          <Download size={14} />
          <span>
            {downloadingChunks
              ? (downloadProgress || 'Đang tải...')
              : downloadedChunks
              ? 'Đã tải xong!'
              : (
                <>
                  <span className="btn-label-desktop">Tải ảnh bill</span>
                  <span className="btn-label-mobile">Tải ảnh</span>
                </>
              )}
          </span>
        </button>

        <button
          type="button"
          className="button secondary bill-copy-text-btn"
          disabled={!expenses.length || downloadingChunks}
          onClick={() => void copyTextFallback()}
          title="Sao chép toàn bộ nội dung dạng văn bản"
        >
          <ReceiptText size={14} />
          <span>{copiedText ? 'Đã chép' : 'Copy text'}</span>
        </button>
        <button type="button" className="button secondary bill-close-btn" onClick={onClose}>
          Đóng
        </button>
      </div>

      {/* Vùng render ngầm các ảnh bill cắt gọn từng 10 hóa đơn để chụp xuất ảnh */}
      <div
        className="bill-chunk-export-container"
        aria-hidden="true"
        style={{
          position: 'fixed',
          left: '-9999px',
          top: 0,
          width: '375px',
          pointerEvents: 'none',
          zIndex: -999,
        }}
      >
        {/* TRANG 1: ĐẦU BILL ĐẾN HẾT QUÉT MÃ VIETQR */}
        <div
          ref={(el) => {
            chunkRefs.current[0] = el
          }}
          className="thermal-receipt-paper bill-printable bill-chunk-paper"
        >
          <div className="receipt-header">
            <div className="receipt-doc-name">PHIẾU THANH TOÁN</div>
            {subtitle && <div className="receipt-subtitle">{subtitle}</div>}
            <div className="receipt-meta">Ngày tính: {formatDate(today())}</div>
          </div>

          <div className="receipt-divider" />

          {/* NOTE(VI): Lý do: Bổ sung thông tin tổng số tiền đã chi tiêu kỳ này vào bill đầu theo yêu cầu người dùng
              Trước: Bill đầu chỉ có ngày tính rồi đến số tiền cần chuyển, không thấy tổng tiền chi cả kỳ
              Sau: Thêm khung Tổng chi tiêu kỳ này (số lượng khoản chi + tổng tiền) ngay sau ngày tính
              Test: Bấm Tải ảnh cắt gọn -> Mở ảnh phần 1 -> Thấy TỔNG CHI TIÊU KỲ NÀY hiển thị rõ ràng */}
          <div className="receipt-summary-block">
            <div className="receipt-summary-line">
              <span>Số lượng khoản chi:</span>
              <b>{expenses.length} khoản</b>
            </div>
            <div className="receipt-total-line">
              <span>TỔNG CHI TIÊU KỲ NÀY:</span>
              <strong className="receipt-grand-total">{money(total)}</strong>
            </div>
          </div>

          <div className="receipt-divider light" />

          {/* SỐ TIỀN CẦN CHUYỂN */}
          <div className="receipt-section-title">SỐ TIỀN CẦN CHUYỂN</div>
          {transferSuggestions.length > 0 ? (
            <div className="receipt-transfer-list">
              {transferSuggestions.map((s, idx) => (
                <div key={idx} className="receipt-transfer-row">
                  <span className="receipt-transfer-names">
                    • <b>{s.fromName}</b> chuyển <b>{s.toName}</b>:
                    {s.note && <small className="receipt-transfer-note">{s.note}</small>}
                  </span>
                  <strong className="receipt-transfer-amount">{money(s.amount)}</strong>
                </div>
              ))}
            </div>
          ) : (
            <div className="receipt-transfer-empty">Đã cân bằng số dư (0 đ)</div>
          )}

          <div className="receipt-divider light" />

          {/* THÔNG TIN CHUYỂN KHOẢN */}
          <div className="receipt-payment-section">
            <div className="receipt-section-title">THÔNG TIN CHUYỂN KHOẢN</div>
            <div className="receipt-bank-card">
              <div>Ngân hàng: <b>TECHCOMBANK</b></div>
              <div>Chủ tài khoản: <b>LE THI LY THUONG</b></div>
              <div>Số tài khoản: <b className="receipt-account-number">1903 8123 1750 16</b></div>
            </div>

            <div className="receipt-qr-wrap">
              <img
                src={QR_PAYMENT_DATA_URL}
                alt="Mã QR Chuyển tiền Techcombank - LE THI LY THUONG"
                className="receipt-qr-code"
              />
              <div className="receipt-qr-hint">
                Quét mã VietQR trên app ngân hàng để chuyển khoản nhanh
              </div>
            </div>
          </div>

          {/* NOTE(VI): Lý do: Đổi footer cuối bill 1 thành "--- PHẦN 1/Y ---" đồng bộ đúng số thứ tự của chính bill
              Trước: Cuối bill 1 ghi "--- DANH SÁCH KHOẢN CHI XEM TIẾP PHẦN 2 --->"
              Sau: Cuối bill 1 ghi "--- PHẦN 1/Y ---"
              Test: Tải ảnh bill -> Bill 1 kết thúc bằng "--- PHẦN 1/Y ---" */}
          {totalSheets > 1 && (
            <>
              <div className="receipt-divider" />
              <div className="receipt-chunk-footer-notice">
                --- PHẦN 1/{totalSheets} ---
              </div>
            </>
          )}
        </div>

        {/* TRANG 2 TRỞ ĐI: CÁC KHOẢN CHI (MỖI TRANG 10 KHOẢN) */}
        {expenseChunks.map((chunkExpenses, cIdx) => {
          const sheetIdx = cIdx + 1
          const sheetNum = cIdx + 2
          const isLast = cIdx === expenseChunks.length - 1

          const chunkDateGroups = chunkExpenses.reduce<{ date: string; expenses: Expense[] }[]>((groups, expense) => {
            const current = groups[groups.length - 1]
            if (current?.date === expense.date) current.expenses.push(expense)
            else groups.push({ date: expense.date, expenses: [expense] })
            return groups
          }, [])

          return (
            <div
              key={`chunk-${cIdx}`}
              ref={(el) => {
                chunkRefs.current[sheetIdx] = el
              }}
              className="thermal-receipt-paper bill-printable bill-chunk-paper"
            >
              {/* NOTE(VI): Lý do: Bỏ phần ngoặc (số thứ tự đầu - số thứ tự cuối) ở đầu danh sách khoản chi các trang 2+ theo yêu cầu người dùng
                  Trước: Tiêu đề hiển thị "DANH SÁCH KHOẢN CHI (1 - 10) · PHẦN 2/5"
                  Sau: Tiêu đề chỉ để "DANH SÁCH KHOẢN CHI" gọn gàng chuẩn bill
                  Test: Bấm Tải ảnh cắt gọn -> Mở ảnh trang 2 trở đi -> Thấy đầu bảng chỉ ghi đúng "DANH SÁCH KHOẢN CHI" */}
              <div className="receipt-section-title" style={{ marginTop: 0 }}>
                DANH SÁCH KHOẢN CHI
              </div>
              <div className="receipt-table-header">
                <span>TÊN KHOẢN CHI</span>
                <span>TIỀN (VNĐ)</span>
              </div>
              <div className="receipt-divider light" />

              {chunkDateGroups.map((group) => (
                <div key={group.date} className="receipt-date-block">
                  <div className="receipt-date-label">📅 {formatDate(group.date)}</div>
                  {group.expenses.map((expense) => {
                    const globalIdx = expenses.indexOf(expense) + 1
                    const splits = expense.splits.filter((s) => s.amount > 0)
                    return (
                      <div key={expense.id} className="receipt-item-row">
                        <div className="receipt-item-main">
                          <span className="receipt-item-title">
                            <b>{String(globalIdx).padStart(2, '0')}.</b> {expense.title}
                          </span>
                          <strong className="receipt-item-amount">{money(expense.amount)}</strong>
                        </div>
                        <div className="receipt-item-sub">
                          <span>Người trả: <b>{memberName(expense.payerId)}</b></span>
                        </div>
                        <div className="receipt-item-split-box">
                          {expense.splitMode === 'equal' ? (
                            <div className="receipt-split-names">
                              {splits.map((s) => memberName(s.memberId)).join(', ')}
                            </div>
                          ) : expense.splitMode === 'percent' ? (
                            <div className="receipt-split-detail-list">
                              {splits.map((s) => {
                                const pct = expense.amount > 0 ? ((s.amount / expense.amount) * 100).toFixed(1).replace('.0', '') : '0'
                                return (
                                  <span key={s.memberId} className="receipt-split-chip">
                                    {memberName(s.memberId)}: <b>{pct}%</b> ({money(s.amount)})
                                  </span>
                                )
                              })}
                            </div>
                          ) : (
                            <div className="receipt-split-detail-list">
                              {splits.map((s) => (
                                <span key={s.memberId} className="receipt-split-chip">
                                  {memberName(s.memberId)}: <b>{money(s.amount)}</b>
                                </span>
                              ))}
                            </div>
                          )}
                          {expense.note && (
                            <div className="receipt-item-note">Ghi chú: {expense.note}</div>
                          )}
                        </div>
                      </div>
                    )
                  })}
                </div>
              ))}

              {/* Trang cuối: Tổng kết tiền + Phần chia từng người */}
              {isLast && (
                <>
                  <div className="receipt-divider double" />

                  {/* Tổng kết tiền */}
                  <div className="receipt-summary-block">
                    <div className="receipt-summary-line">
                      <span>Số lượng khoản chi:</span>
                      <b>{expenses.length} khoản</b>
                    </div>
                    <div className="receipt-total-line">
                      <span>TỔNG TIỀN:</span>
                      <strong className="receipt-grand-total">{money(total)}</strong>
                    </div>
                  </div>

                  <div className="receipt-divider" />

                  {/* Bảng phân chia theo từng người trong nhóm */}
                  <div className="receipt-section-title">PHẦN PHẢI CHI TRẢ TỪNG NGƯỜI</div>
                  <div className="receipt-breakdown-list">
                    {memberBreakdown.map((m) => (
                      <div key={m.id} className="receipt-breakdown-row">
                        <span className="receipt-member-name">• {m.name}</span>
                        <div className="receipt-member-amounts">
                          <strong>{money(m.share)}</strong>
                          {m.paid > 0 && <small>Đã chi: {money(m.paid)}</small>}
                        </div>
                      </div>
                    ))}
                  </div>
                </>
              )}

              {/* NOTE(VI): Lý do: Đánh số thứ tự phần x/y đồng bộ cho tất cả các bill ở cuối bill
                  Trước: Bill sau ghi "còn tiếp (phần x/y)" là chỉ số trang tiếp theo
                  Sau: Tất cả các bill đều kết thúc bằng "--- PHẦN X/Y ---" chỉ đúng số thứ tự của chính bill đó
                  Test: Bấm Tải ảnh bill -> Bill 2 là "--- PHẦN 2/5 ---", Bill cuối là "--- PHẦN 5/5 ---" */}
              {totalSheets > 1 && (
                <>
                  <div className="receipt-divider" />
                  <div className="receipt-chunk-footer-notice">
                    --- PHẦN {sheetNum}/{totalSheets} ---
                  </div>
                </>
              )}
            </div>
          )
        })}
      </div>
    </Modal>
  )
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
  {/* NOTE(VI): Lý do: Bỏ text "Tự cập nhật theo tất cả khoản chi và lần trả." và bỏ text "Cần trả/Sẽ nhận" ở panel Số dư hiện tại; ẩn thành viên 0đ
      Trước: Có thẻ <p> phụ đề và thẻ <small> ghi Cần trả / Sẽ nhận; thành viên 0đ vẫn hiển thị
      Sau: Bỏ thẻ <p> và <small>, chỉ giữ avatar, tên và số tiền (+/-); thành viên 0đ được ẩn đi
      Test: Vào tab Khoản chi -> Panel Số dư hiện tại gọn sạch, thành viên 0đ không hiển thị */}
  return <section className="settlement-layout current-money-overview">
    <div className="panel balance-panel">
      <div className="panel-heading"><div><h2>Số dư hiện tại</h2></div></div>
      <div className="balance-list">{members.length ? members.map((member, index) => { const amount = balances.get(member.id) ?? 0; return <div className="balance-row" key={member.id}><MemberAvatar member={member} index={index} /><span className="person-info"><strong>{member.name}</strong></span><strong className={`balance-amount ${amount > 0 ? 'positive' : amount < 0 ? 'negative' : ''}`}>{amount > 0 ? '+' : ''}{money(amount)}</strong></div> }) : <div className="empty-state compact"><p>Tất cả thành viên đã cân bằng số dư (0 đ).</p></div>}</div>
    </div>

  </section>
}

// NOTE(VI): Lý do: Bổ sung bóc tách nợ cũ và nợ mới vào text sao chép và UI dòng gợi ý chuyển tiền theo yêu cầu người dùng
// Trước: Chỉ hiển thị số tiền gộp chung, không biết nợ cũ bao nhiêu nợ mới bao nhiêu
// Sau: Tự động phân tích và gắn ghi chú (Kỳ cũ còn X, kỳ này Y) hoặc (Kỳ này Y - Đã trừ X kỳ trước), hỗ trợ cả khi copy và hiển thị trên giao diện
// Test: Tạo kỳ có thành viên nợ dồn kỳ cũ -> thấy dòng chú thích dưới tên trên UI và trong text khi bấm Sao chép
function SettlementSuggestionsPanel({
  suggestions,
  members,
  ledger,
  onRecord,
  groupName: _groupName,
  inline = false,
}: {
  suggestions: ReturnType<typeof suggestSettlements>
  members: Member[]
  ledger: Ledger
  onRecord: (fromId: string, toId: string, amount: number) => void
  groupName?: string
  inline?: boolean
}) {
  const [copied, setCopied] = useState(false)

  const suggestionText = useMemo(() => {
    if (!suggestions.length) return ''
    return suggestions
      .map((s) => {
        const from = members.find((m) => m.id === s.fromMemberId)?.name ?? 'Thành viên'
        const to = members.find((m) => m.id === s.toMemberId)?.name ?? 'Thành viên'
        const breakdown = getMemberDebtBreakdown(ledger, s.fromMemberId)
        const noteStr = breakdown.note ? ` (${breakdown.note})` : ''
        return `${from} chuyển ${to}: ${money(s.amount)}${noteStr}`
      })
      .join('\n')
  }, [suggestions, members, ledger])

  async function copySuggestions() {
    if (!suggestionText) return
    try {
      await navigator.clipboard.writeText(suggestionText)
      setCopied(true)
    } catch {
      const textArea = document.createElement('textarea')
      textArea.value = suggestionText
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

  return <div className={`panel ${inline ? 'inline-suggestions-panel' : ''}`}>
    <div className="panel-heading">
      <h2>Gợi ý chuyển tiền</h2>
      {suggestions.length > 0 && (
        <button
          type="button"
          className={`filter-button ${copied ? 'active' : ''}`}
          onClick={() => void copySuggestions()}
          title="Sao chép nội dung chuyển tiền để gửi vào nhóm chat"
        >
          {copied ? <Check size={14} /> : <Copy size={14} />}
          <span>{copied ? 'Đã chép' : 'Sao chép'}</span>
        </button>
      )}
    </div>
    {suggestions.length ? <div className="suggestion-list">{suggestions.map((suggestion) => {
      const from = members.find((member) => member.id === suggestion.fromMemberId)
      const to = members.find((member) => member.id === suggestion.toMemberId)
      if (!from || !to) return null
      const breakdown = getMemberDebtBreakdown(ledger, from.id)
      return <div className="suggestion-row" key={`${from.id}-${to.id}`}>
        {/* NOTE(VI): Lý do: Đổi "chuyển cho" thành "trả" và đặt icon avatar người nhận ngay trước tên người nhận
            Trước: (Avatar from) Kha chuyển cho Thương (Avatar to ở cuối)
            Sau: (Avatar from) Kha trả (Avatar to) Thương
            Test: Vào tab Quyết toán -> Kiểm tra mục Gợi ý chuyển tiền: hiển thị icon người chuyển, tên, chữ "trả", icon người nhận, tên người nhận */}
        <div className="suggestion-people">
          <MemberAvatar member={from} index={members.indexOf(from)} />
          <span className="suggestion-name">{from.name}</span>
          <span className="suggestion-verb">chuyển</span>
          <MemberAvatar member={to} index={members.indexOf(to)} />
          <span className="suggestion-name">{to.name}</span>
        </div>
        <strong>{money(suggestion.amount)}</strong>
        {/* NOTE(VI): Lý do: Bỏ chữ "Đã trả", chỉ để dấu check ✓ theo yêu cầu người dùng
            Trước: Nút gồm icon Check + chữ "Đã trả", chiếm nhiều diện tích khiến tên thành viên bị co ngắn (Th..., Thư...)
            Sau: Nút chỉ còn dấu check ✓ gọn gàng, tăng không gian hiển thị tên thành viên
            Test: Xem bảng Gợi ý chuyển tiền -> Tên hiển thị đầy đủ hơn, nút xác nhận là icon check ✓ gọn đẹp */}
        <button
          type="button"
          className="button small-button suggestion-check-btn"
          onClick={() => onRecord(from.id, to.id, suggestion.amount)}
          title="Xác nhận đã chuyển"
          aria-label={`Xác nhận ${from.name} đã chuyển cho ${to.name}`}
        >
          <Check size={15} strokeWidth={2.4} />
        </button>
        {breakdown.note && <div className="suggestion-debt-note">{breakdown.note}</div>}
      </div>
    })}</div> : <div className="empty-state compact"><div className="empty-icon"><Check size={20} /></div><strong>Sổ đang cân bằng</strong><p>Không còn khoản nào cần chốt sổ.</p></div>}
  </div>
}

// NOTE(VI): Lý do: Đặt số tiền vào ô nhập (input) ngay từ đầu để người dùng có thể xác nhận ngay hoặc click thẳng vào ô sửa số tiền nếu trả thiếu/khác mức gợi ý, không cần nút bấm trung gian "Sửa số tiền"
// Trước: Hiển thị text tĩnh kèm nút "Sửa số tiền" phải bấm mới hiện ô nhập
// Sau: Ô input hiển thị sẵn số tiền gợi ý, cho phép sửa trực tiếp hoặc bấm "Xác nhận đã trả" ngay lập tức
// Test: Bấm "Đã trả" ở gợi ý -> thấy ô số tiền hiển thị sẵn số tiền gợi ý; bấm thẳng "Xác nhận đã trả" -> lưu đúng số tiền; click vào ô sửa số khác -> lưu đúng số mới
function ConfirmSettlementModal({ from, to, amount, onClose, onConfirm }: { from: string; to: string; amount: number; onClose: () => void; onConfirm: (actualAmount: number) => Promise<void> }) {
  const [saving, setSaving] = useState(false)
  const [customAmount, setCustomAmount] = useState(String(amount))
  const parsedAmount = Number(customAmount.replace(/\D/g, '')) || 0

  async function confirm() {
    if (parsedAmount <= 0) return
    setSaving(true)
    try {
      await onConfirm(parsedAmount)
    } finally {
      setSaving(false)
    }
  }

  return <Modal centered eyebrow={null} title="Xác nhận đã trả" subtitle="Chỉ xác nhận nếu khoản tiền đã được chuyển." onClose={onClose}>
    <div className="confirm-settlement-content">
      <div className="confirm-transfer">
        <span className="confirm-member">{from.slice(0, 1)}</span>
        <ArrowRight size={17} />
        <span className="confirm-member receiver">{to.slice(0, 1)}</span>
      </div>
      <p><strong>{from}</strong> đã chuyển cho <strong>{to}</strong></p>
      <div style={{ margin: '6px 0 2px', display: 'grid', justifyItems: 'center', gap: '5px' }}>
        <div style={{ position: 'relative', display: 'inline-flex', alignItems: 'center' }}>
          <input
            type="text"
            inputMode="numeric"
            style={{
              textAlign: 'center',
              fontSize: '22px',
              fontWeight: 800,
              fontFamily: 'Manrope, sans-serif',
              padding: '10px 28px 10px 14px',
              width: '190px',
              borderRadius: '12px',
              border: '1.5px solid #287b5d',
              outline: 'none',
              color: '#287b5d',
              background: '#ffffff',
            }}
            value={customAmount ? new Intl.NumberFormat('vi-VN').format(parsedAmount) : ''}
            onChange={(e) => setCustomAmount(e.target.value.replace(/\D/g, ''))}
          />
          <span style={{ position: 'absolute', right: '14px', fontWeight: 800, fontSize: '18px', color: '#287b5d', pointerEvents: 'none' }}>₫</span>
        </div>
        <small style={{ fontSize: '12px', color: '#666e66' }}>Nhập số tiền thực tế đã chuyển</small>
      </div>
    </div>
    <div className="modal-actions">
      <button type="button" className="button secondary" disabled={saving} onClick={onClose}>Chưa, quay lại</button>
      <button type="button" className="button primary" disabled={saving || parsedAmount <= 0} onClick={() => void confirm()}>
        <Check size={16} /> {saving ? 'Đang lưu...' : 'Xác nhận đã trả'}
      </button>
    </div>
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

// NOTE(VI): Lý do: Đưa Lịch sử trả tiền vào popup Modal riêng theo yêu cầu người dùng khi gộp menu Chốt sổ vào màn hình chính
// Trước: Lịch sử trả tiền nằm trực tiếp ở trang Quyết toán/Chốt sổ
// Sau: Mở dạng modal khi bấm nút "Xem lịch sử trả tiền" trong vùng kỳ hiện tại; giữ nguyên toàn bộ bộ lọc, phân trang và nút xóa giao dịch
// Test: Bấm nút "Xem lịch sử trả tiền" -> modal mở lên -> kiểm tra danh sách, lật trang, bộ lọc và xóa giao dịch hoạt động chuẩn
function SettlementHistoryModal({
  members,
  settlements,
  filteredSettlements,
  visibleSettlements,
  displaySettlements,
  safeSettlementPage,
  settlementPageCount,
  hasSettlementFilter,
  settlementFilters,
  showSettlementFilters,
  onToggleFilters,
  onFilterChange,
  onClearFilters,
  onPageChange,
  onDeleteSettlement,
  onClose,
}: {
  members: Member[]
  settlements: Settlement[]
  filteredSettlements: Settlement[]
  visibleSettlements: Settlement[]
  displaySettlements: Settlement[]
  safeSettlementPage: number
  settlementPageCount: number
  hasSettlementFilter: boolean
  settlementFilters: { fromDate: string; toDate: string; memberId: string }
  showSettlementFilters: boolean
  onToggleFilters: () => void
  onFilterChange: (filters: { fromDate: string; toDate: string; memberId: string }) => void
  onClearFilters: () => void
  onPageChange: (page: number) => void
  onDeleteSettlement: (settlement: Settlement) => void
  onClose: () => void
}) {
  return (
    <Modal
      centered
      wide
      eyebrow="SỔ CHI TIÊU NHÓM"
      title="Lịch sử trả tiền"
      subtitle="Các lần thành viên đã chuyển tiền cho nhau"
      onClose={onClose}
    >
      <div style={{ display: 'grid', gap: '10px', padding: '4px 0 16px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '8px' }}>
          <button
            type="button"
            className={`filter-button ${showSettlementFilters ? 'active' : ''}`}
            aria-expanded={showSettlementFilters}
            onClick={onToggleFilters}
          >
            <Filter size={14} /> <span>Lọc</span>
            {hasSettlementFilter && (
              <span className="filter-badge">
                {Object.values(settlementFilters).filter(Boolean).length}
              </span>
            )}
          </button>
        </div>

        {showSettlementFilters && (
          <div className="expense-filters">
            <div className="expense-filter-fields">
              <label>
                Từ ngày
                <input
                  type="date"
                  value={settlementFilters.fromDate}
                  onChange={(event) => onFilterChange({ ...settlementFilters, fromDate: event.target.value })}
                />
              </label>
              <label>
                Đến ngày
                <input
                  type="date"
                  value={settlementFilters.toDate}
                  onChange={(event) => onFilterChange({ ...settlementFilters, toDate: event.target.value })}
                />
              </label>
              <label>
                Thành viên
                <select
                  value={settlementFilters.memberId}
                  onChange={(event) => onFilterChange({ ...settlementFilters, memberId: event.target.value })}
                >
                  <option value="">Tất cả thành viên</option>
                  {members.map((member) => (
                    <option key={member.id} value={member.id}>
                      {member.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div className="filters-footer">
              <span />
              <button disabled={!hasSettlementFilter} onClick={onClearFilters}>
                Xóa bộ lọc
              </button>
            </div>
          </div>
        )}

        {filteredSettlements.length ? (
          <>
            <div className="settlement-history">
              {visibleSettlements.map((settlement) => {
                const from = members.find((member) => member.id === settlement.fromMemberId)
                const to = members.find((member) => member.id === settlement.toMemberId)
                return (
                  <div className="history-row" key={settlement.id}>
                    <button
                      type="button"
                      className="history-icon history-delete-button"
                      aria-label="Xóa khoản trả tiền"
                      title="Xóa khoản trả tiền"
                      onClick={() => onDeleteSettlement(settlement)}
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
              total={displaySettlements.length}
              onPageChange={onPageChange}
            />
            {!hasSettlementFilter && settlements.length > 30 && (
              <p style={{ textAlign: 'center', fontSize: '11.5px', color: '#666e66', margin: '8px 0 2px' }}>
                Hiển thị 2 trang gần nhất. Dùng bộ lọc để xem các khoản cũ hơn.
              </p>
            )}
          </>
        ) : (
          <div className="empty-state compact">
            <p>
              {settlements.length
                ? 'Không tìm thấy giao dịch phù hợp với bộ lọc.'
                : 'Chưa có lần trả tiền nào.'}
            </p>
          </div>
        )}
      </div>
      <div className="modal-actions">
        <button type="button" className="button secondary full" onClick={onClose}>
          Đóng
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

function ExpenseModal({
  members,
  initial,
  lastExpenseMemberIds,
  minDate,
  onClose,
  onSave,
}: {
  members: Member[]
  initial: Expense | null
  lastExpenseMemberIds?: string[]
  minDate?: string
  onClose: () => void
  onSave: (expense: Expense) => void
}) {
  const [title, setTitle] = useState(initial?.title ?? '')
  const [amount, setAmount] = useState(initial?.amount ? String(initial.amount) : '')
  const [payerId, setPayerId] = useState(initial?.payerId ?? members[0]?.id ?? '')
  const [date, setDate] = useState(initial?.date ?? today())
  const [category, setCategory] = useState(initial?.category ?? categories[0])
  const [note, setNote] = useState(initial?.note ?? '')

  // NOTE(VI): Lý do: Lưu danh sách người chia tiền vào localStorage để lần sau mở popup tự động chọn lại đúng những người đã chọn đợt trước
  // Trước: Nếu localStorage trống thì chọn tất cả thành viên; không fallback sang khoản chi gần nhất
  // Sau: Ưu tiên localStorage -> fallback khoản chi gần nhất trong sổ -> nếu chưa có thì chọn tất cả; khi toggle hoặc submit đều lưu ngay vào localStorage
  // Test: Thêm khoản chi chọn 3 người A, B, C -> Lưu -> Bấm "Thêm khoản chi" tiếp theo -> Thấy tự động chọn sẵn 3 người A, B, C
  const [selected, setSelected] = useState<string[]>(() => {
    if (initial) return initial.splits.map((item) => item.memberId)
    try {
      const saved = JSON.parse(localStorage.getItem('expense-split-member-ids') ?? 'null')
      if (Array.isArray(saved) && saved.length > 0) {
        const savedIds = new Set(saved.filter((id): id is string => typeof id === 'string'))
        const remembered = members.filter((member) => savedIds.has(member.id)).map((member) => member.id)
        if (remembered.length > 0) return remembered
      }
    } catch { /* Use fallback if local storage is unavailable. */ }
    if (lastExpenseMemberIds && lastExpenseMemberIds.length > 0) {
      const fallbackIds = new Set(lastExpenseMemberIds)
      const remembered = members.filter((member) => fallbackIds.has(member.id)).map((member) => member.id)
      if (remembered.length > 0) return remembered
    }
    return members.map((member) => member.id)
  })

  // NOTE(VI): Lý do: Mặc định chọn "Chia đều" khi thêm khoản chi mới theo yêu cầu người dùng
  // Trước: const [splitMode, setSplitMode] = useState<'equal' | 'custom'>(initial?.splitMode === 'equal' ? 'equal' : 'custom') -> khi initial null ra false, bị chọn "Tùy chỉnh số tiền"
  // Sau: initial ? (initial.splitMode === 'equal' ? 'equal' : 'custom') : 'equal' -> khi thêm mới luôn chọn "Chia đều"
  // Test: Bấm "Thêm khoản chi" -> Nút "Chia đều" sáng xanh, phần nhập tùy chỉnh/phần trăm bị ẩn
  const [splitMode, setSplitMode] = useState<'equal' | 'custom'>(initial ? (initial.splitMode === 'equal' ? 'equal' : 'custom') : 'equal')
  const [custom, setCustom] = useState<Record<string, string>>(Object.fromEntries(initial?.splits.map((item) => [item.memberId, String(item.amount)]) ?? []))
  // NOTE(VI): Lý do: Mặc định chọn chia theo % khi tùy chỉnh số tiền theo yêu cầu người dùng
  // Trước: const [splitByPercent, setSplitByPercent] = useState(() => initial ? initial.splitMode === 'percent' : false) -> false khi tạo mới
  // Sau: useState(() => initial ? initial.splitMode === 'percent' : true) -> true khi tạo mới
  // Test: Bấm "Thêm khoản chi" -> chuyển sang "Tùy chỉnh số tiền" -> Nút gạt "Chia theo %" ở trạng thái bật ON sẵn
  const [splitByPercent, setSplitByPercent] = useState(() => initial ? initial.splitMode === 'percent' : true)
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
    try {
      localStorage.setItem('expense-split-member-ids', JSON.stringify(selected))
    } catch { /* ignore */ }
    onSave({ id: initial?.id ?? makeId(), title: title.trim(), amount: numericAmount, payerId, date, category, note: note.trim(), splitMode: finalSplitMode, splits, periodId: initial?.periodId ?? null, createdAt: initial?.createdAt, updatedAt: new Date().toISOString() })
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
    {splitMode === 'custom' && <div className="custom-splits"><div className="custom-splits-header"><label className="percentage-toggle ios-switch-wrap"><input type="checkbox" className="ios-switch-input" checked={splitByPercent} onChange={(event) => setSplitByPercent(event.target.checked)} /><span className="ios-switch-slider" aria-hidden="true" /><span className="percentage-toggle-label">Chia theo %</span></label>{splitByPercent && <small>Tổng phải bằng 100%</small>}</div>{members.filter((member) => selected.includes(member.id)).map((member) => {
      const splitAmount = percentSplits.find((item) => item.memberId === member.id)?.amount ?? 0
      return <label className="custom-split-row" key={member.id}><span>{member.name}</span>{splitByPercent ? <span className="split-input-pair"><input aria-label={`Tỷ lệ chia của ${member.name}`} inputMode="decimal" placeholder="%" value={percentages[member.id] ?? ''} onChange={(event) => setPercent(member.id, event.target.value)} /><input aria-label={`Số tiền của ${member.name}`} placeholder="VND" value={numericAmount ? new Intl.NumberFormat('vi-VN').format(splitAmount) : ''} readOnly /></span> : <input className="custom-amount-input" aria-label={`Số tiền của ${member.name}`} inputMode="numeric" placeholder="VND" value={custom[member.id] ? new Intl.NumberFormat('vi-VN').format(Number(custom[member.id].replace(/[,.\s]/g, ''))) : ''} onChange={(event) => setCustom({ ...custom, [member.id]: event.target.value.replace(/\D/g, '') })} />}</label>
    })}</div>}
    <div className={`split-summary ${!splitIsValid ? 'invalid' : ''}`}><span>{splitMode === 'custom' && splitByPercent ? 'Tổng tỷ lệ' : 'Tổng phần chia'}</span><strong>{splitMode === 'custom' && splitByPercent ? `${Number(percentTotal.toFixed(2))}%` : money(splitTotal || 0)}{!splitIsValid && <small>{splitByPercent ? ' · Cần đủ 100%' : ` · Cần khớp ${money(numericAmount || 0)}`}</small>}</strong></div>
    <label>Ghi chú <span className="optional">(không bắt buộc)</span><textarea rows={2} maxLength={400} placeholder="Thêm thông tin nếu cần..." value={note} onChange={(e) => setNote(e.target.value)} /></label>
    <div className="modal-actions"><button type="button" className="button secondary" onClick={onClose}>Hủy</button><button className="button primary" disabled={!title.trim() || numericAmount < 1 || !selected.length || !splitIsValid}><Check size={16} /> Lưu khoản chi</button></div>
  </form></Modal>
}

// NOTE(VI): Lý do: Khóa cuộn nền bên dưới và đồng bộ khung hiển thị của tất cả popup theo Visual Viewport trên iPhone/mobile khi bàn phím ảo bật lên
// Trước: Khi bấm "+ Thêm khoản chi" (hoặc sửa/thêm tên thành viên ở popup Tài khoản), ô input có autoFocus làm bàn phím iOS bật lên và đẩy dịch Layout Viewport lên trên, khiến nửa đầu popup (tiêu đề + ô nhập đang có con trỏ) bị đẩy khuất lên khỏi mép trên màn hình, chỉ nhìn thấy phần cuối popup
// Sau:
// 1. Neo trực tiếp .modal-backdrop và giới hạn chiều cao .modal-card theo window.visualViewport (vùng hiển thị thực tế phía trên bàn phím ảo)
// 2. Khi mở popup hoặc khi con trỏ ở ô đầu popup (như "Tên khoản chi"), cố định card.scrollTop = 0 để luôn hiển thị đúng đầu popup ngay chỗ con trỏ
// 3. Khi người dùng bấm vào các ô nhập ở phía dưới (như Ghi chú, Tùy chỉnh %, Thêm/Sửa thành viên), tự động cuộn bên trong card vừa đủ để ô đang nhập luôn hiện rõ phía trên bàn phím
// Test: Mở "+ Thêm khoản chi" trên điện thoại -> bàn phím hiện lên nhưng popup hiển thị ngay phần đầu (tiêu đề Thêm khoản chi + ô Tên khoản chi đang có con trỏ); bấm xuống ô Ghi chú hoặc mở các popup khác (Tài khoản, Xác nhận đã trả...) đều hiển thị chuẩn chỗ con trỏ
let activeModalLockCount = 0
let lockedWindowScrollY = 0

function Modal({ title, subtitle, onClose, children, centered = false, wide = false, eyebrow = 'SỔ CHI TIÊU NHÓM', className = '' }: { title: string; subtitle: string; onClose: () => void; children: React.ReactNode; centered?: boolean; wide?: boolean; eyebrow?: string | null; className?: string }) {
  const backdropRef = useRef<HTMLDivElement>(null)
  const cardRef = useRef<HTMLElement>(null)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  useLayoutEffect(() => {
    const handler = (event: KeyboardEvent) => { if (event.key === 'Escape') onCloseRef.current() }
    window.addEventListener('keydown', handler)

    if (activeModalLockCount === 0) {
      lockedWindowScrollY = window.scrollY || window.pageYOffset || document.documentElement.scrollTop || 0
      document.documentElement.style.overflow = 'hidden'
      document.documentElement.style.overscrollBehavior = 'none'
      document.body.style.overflow = 'hidden'
      document.body.style.overscrollBehavior = 'none'
      document.body.style.position = 'fixed'
      document.body.style.top = `-${lockedWindowScrollY}px`
      document.body.style.left = '0'
      document.body.style.right = '0'
      document.body.style.width = '100%'
    }
    activeModalLockCount += 1

    const backdrop = backdropRef.current
    const card = cardRef.current
    if (card) {
      card.scrollTop = 0
    }

    const timerIds: number[] = []
    const clearScheduledTimers = () => {
      while (timerIds.length > 0) {
        const id = timerIds.pop()
        if (id !== undefined) window.clearTimeout(id)
      }
    }

    const syncModalViewport = (ensureFocusVisible = false) => {
      const currentBackdrop = backdropRef.current
      const currentCard = cardRef.current
      if (!currentBackdrop || !currentCard) return

      if (window.scrollY !== 0 || window.pageYOffset !== 0) {
        window.scrollTo(0, 0)
      }

      const vv = window.visualViewport
      const vvTop = vv ? Math.max(0, vv.offsetTop) : 0
      const vvHeight = vv ? vv.height : window.innerHeight
      const isKeyboardOpen = window.innerHeight - vvHeight > 100

      currentBackdrop.style.top = `${vvTop}px`
      currentBackdrop.style.height = `${vvHeight}px`
      currentBackdrop.style.bottom = 'auto'
      currentBackdrop.style.paddingBottom = isKeyboardOpen ? '10px' : ''

      const backdropStyle = window.getComputedStyle(currentBackdrop)
      const padTop = parseFloat(backdropStyle.paddingTop) || 14
      const padBottom = parseFloat(backdropStyle.paddingBottom) || 14
      const availableCardHeight = Math.max(180, Math.min(740, vvHeight - padTop - padBottom))
      currentCard.style.maxHeight = `${availableCardHeight}px`

      if (ensureFocusVisible) {
        const activeEl = document.activeElement
        if (
          activeEl instanceof HTMLElement &&
          currentCard.contains(activeEl) &&
          (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA' || activeEl.tagName === 'SELECT')
        ) {
          const cardRect = currentCard.getBoundingClientRect()
          const elRect = activeEl.getBoundingClientRect()
          const elOffsetTopInCard = (elRect.top - cardRect.top) + currentCard.scrollTop

          if (elOffsetTopInCard < 150) {
            currentCard.scrollTop = 0
          } else if (elRect.top < cardRect.top + 20) {
            currentCard.scrollTop = Math.max(0, currentCard.scrollTop - (cardRect.top + 28 - elRect.top))
          } else if (elRect.bottom > cardRect.bottom - 16) {
            currentCard.scrollTop = currentCard.scrollTop + (elRect.bottom - (cardRect.bottom - 24))
          }
        }
      }
    }

    const scheduleViewportSync = (ensureFocusVisible: boolean) => {
      clearScheduledTimers()
      syncModalViewport(ensureFocusVisible)
      const delays = [40, 120, 240, 380]
      for (const delay of delays) {
        timerIds.push(window.setTimeout(() => syncModalViewport(ensureFocusVisible), delay))
      }
    }

    scheduleViewportSync(true)

    const handleViewportChange = () => syncModalViewport(true)
    const handleFocusIn = () => scheduleViewportSync(true)
    const handleFocusOut = () => scheduleViewportSync(false)

    const vv = window.visualViewport
    vv?.addEventListener('resize', handleViewportChange)
    vv?.addEventListener('scroll', handleViewportChange)
    window.addEventListener('resize', handleViewportChange)
    card?.addEventListener('focusin', handleFocusIn)
    card?.addEventListener('focusout', handleFocusOut)

    let lastTouchY = 0

    const findScrollableParent = (target: EventTarget | null): HTMLElement | null => {
      const currentCard = cardRef.current
      if (!currentCard || !(target instanceof HTMLElement) || !currentCard.contains(target)) return null
      let el: HTMLElement | null = target
      while (el && el !== currentCard.parentElement) {
        if (el.scrollHeight > el.clientHeight + 1) {
          const style = window.getComputedStyle(el)
          if (style.overflowY === 'auto' || style.overflowY === 'scroll' || el.tagName === 'TEXTAREA') {
            return el
          }
        }
        el = el.parentElement
      }
      return null
    }

    const handleTouchStart = (e: TouchEvent) => {
      if (e.touches.length === 1) {
        lastTouchY = e.touches[0].clientY
      }
    }

    const handleTouchMove = (e: TouchEvent) => {
      const scrollable = findScrollableParent(e.target)
      if (!scrollable) {
        if (e.cancelable) e.preventDefault()
        return
      }
      if (e.touches.length !== 1) return
      const currentY = e.touches[0].clientY
      const deltaY = currentY - lastTouchY
      lastTouchY = currentY
      const atTop = scrollable.scrollTop <= 0
      const atBottom = scrollable.scrollTop + scrollable.clientHeight >= scrollable.scrollHeight - 1
      if ((deltaY > 0 && atTop) || (deltaY < 0 && atBottom)) {
        if (e.cancelable) e.preventDefault()
      }
    }

    const handleWheel = (e: WheelEvent) => {
      const scrollable = findScrollableParent(e.target)
      if (!scrollable) {
        if (e.cancelable) e.preventDefault()
        return
      }
      const atTop = scrollable.scrollTop <= 0
      const atBottom = scrollable.scrollTop + scrollable.clientHeight >= scrollable.scrollHeight - 1
      if ((e.deltaY < 0 && atTop) || (e.deltaY > 0 && atBottom)) {
        if (e.cancelable) e.preventDefault()
      }
    }

    if (backdrop) {
      backdrop.addEventListener('touchstart', handleTouchStart, { passive: true })
      backdrop.addEventListener('touchmove', handleTouchMove, { passive: false })
      backdrop.addEventListener('wheel', handleWheel, { passive: false })
    }

    return () => {
      clearScheduledTimers()
      window.removeEventListener('keydown', handler)
      vv?.removeEventListener('resize', handleViewportChange)
      vv?.removeEventListener('scroll', handleViewportChange)
      window.removeEventListener('resize', handleViewportChange)
      card?.removeEventListener('focusin', handleFocusIn)
      card?.removeEventListener('focusout', handleFocusOut)
      if (backdrop) {
        backdrop.removeEventListener('touchstart', handleTouchStart)
        backdrop.removeEventListener('touchmove', handleTouchMove)
        backdrop.removeEventListener('wheel', handleWheel)
      }
      activeModalLockCount = Math.max(0, activeModalLockCount - 1)
      if (activeModalLockCount === 0) {
        document.documentElement.style.overflow = ''
        document.documentElement.style.overscrollBehavior = ''
        document.body.style.overflow = ''
        document.body.style.overscrollBehavior = ''
        document.body.style.position = ''
        document.body.style.top = ''
        document.body.style.left = ''
        document.body.style.right = ''
        document.body.style.width = ''
        window.scrollTo(0, lockedWindowScrollY)
      }
    }
  }, [])

  return <div ref={backdropRef} className={`modal-backdrop ${centered ? 'centered-backdrop' : ''} ${className}`} onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}><section ref={cardRef} className={`modal-card ${centered ? 'centered-modal' : ''} ${wide ? 'wide-modal' : ''}`}><div className="modal-heading"><div>{eyebrow && <span className="eyebrow">{eyebrow}</span>}<h2>{title}</h2>{subtitle && <p>{subtitle}</p>}</div><button className="icon-button" onClick={onClose} aria-label="Đóng"><X size={18} /></button></div>{children}</section></div>
}