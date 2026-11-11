import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './styles.css'
import './phone.css'

class AppErrorBoundary extends React.Component<React.PropsWithChildren, { error: string | null }> {
  state = { error: null }

  static getDerivedStateFromError(error: Error) {
    return { error: error.message }
  }

  componentDidCatch(error: Error) {
    console.error('App failed to render:', error)
  }

  render() {
    if (this.state.error) return <main className="loading-screen"><div><h1>App chưa mở được</h1><p>{this.state.error}</p><button className="button secondary" onClick={() => window.location.reload()}>Tải lại</button></div></main>
    return this.props.children
  }
}

// NOTE(VI): Lý do: Đăng ký Service Worker (Network-First + Offline Cache Fallback) cho cả môi trường DEV (localhost) và PROD, đồng thời tự động warm-up cache các tài nguyên đã tải ở lần mở đầu tiên
// Trước: Ở môi trường DEV gọi unregister() xóa Service Worker và chỉ đăng ký sw.js ở PROD -> khi bật Offline trong DevTools và bấm F5 sẽ bị lỗi khủng long ERR_INTERNET_DISCONNECTED
// Sau: Đăng ký /sw.js ở mọi môi trường; khi có mạng luôn lấy code mới nhất từ server, khi mất mạng (offline) tự động phục vụ toàn bộ trang và module từ CacheStorage
// Test: Mở app -> chuyển Network sang Offline -> bấm F5 tải lại trang -> App vẫn mở lên và hoạt động bình thường
function registerOfflineServiceWorker() {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return

  const warmUpCurrentPageResources = async () => {
    if (!navigator.onLine) return
    try {
      const registration = await navigator.serviceWorker.ready
      const activeWorker = registration.active || navigator.serviceWorker.controller
      if (!activeWorker) return
      const resourceUrls = performance
        .getEntriesByType('resource')
        .map((entry) => entry.name)
        .filter((url) => url.startsWith(window.location.origin) && !url.includes('supabase.co'))
      const urls = Array.from(new Set(['/', '/version.js', '/manifest.webmanifest', '/icon.svg', ...resourceUrls]))
      activeWorker.postMessage({ type: 'CACHE_URLS', urls })
    } catch {
      // Ignore warm-up errors when offline
    }
  }

  window.addEventListener('load', () => {
    void navigator.serviceWorker
      .register('/sw.js', { scope: '/', updateViaCache: 'none' })
      .then(() => {
        void warmUpCurrentPageResources()
        window.setTimeout(() => void warmUpCurrentPageResources(), 1500)
      })
      .catch(() => {
        // Ignore service worker registration errors in unsupported environments
      })
  })
}

registerOfflineServiceWorker()

// NOTE(VI): Lý do: Tự động dọn sạch query param ?_reload=... trên URL sau khi vừa reload để thanh địa chỉ sạch đẹp
// Trước: Link giữ nguyên ?_reload=1793899... trên thanh địa chỉ
// Sau: Trả URL về trang chủ sạch sẽ sau khi trang đã nạp xong
// Test: Bấm cập nhật -> Trang reload -> URL hiển thị http://localhost:5173/ sạch sẽ
if (typeof window !== 'undefined' && window.location.search.includes('_reload=')) {
  const cleanSearch = window.location.search.replace(/[?&]_reload=\d+/, '').replace(/^&/, '?')
  const cleanUrl = window.location.pathname + (cleanSearch ? cleanSearch : '') + window.location.hash
  window.history.replaceState({}, document.title, cleanUrl || '/')
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode><AppErrorBoundary><App /></AppErrorBoundary></React.StrictMode>,
)

// NOTE(VI): Lý do: Tự động phát hiện phiên bản mới từ version.js để update tính năng mới trên thiết bị người dùng.
// Lưu ý: Chỉ kích hoạt trên môi trường PROD (bản build / deploy thật). Không chạy ở localhost dev để không xung đột với Vite HMR.
function initVersionWatcher() {
  if (typeof window === 'undefined') return

  let isUpdating = false
  async function checkForUpdate() {
    if (isUpdating) return
    try {
      const response = await fetch(`/version.js?_t=${Date.now()}`, { cache: 'no-store' })
      if (!response.ok) return
      const text = await response.text()
      const match = text.match(/APP_VERSION\s*=\s*['"]([^'"]+)['"]/)
      const latestVersion = match?.[1]
      const currentVersion = (typeof window !== 'undefined' && (window as any).__APP_VERSION__) || (typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '1.0.0')

      if (latestVersion && latestVersion !== currentVersion) {
        isUpdating = true
        console.log(`[Update] Phát hiện phiên bản mới: v${latestVersion} (hiện tại v${currentVersion}). Đang tự động cập nhật...`)
        
        try {
          if ('caches' in window) {
            const cacheKeys = await caches.keys()
            await Promise.all(cacheKeys.map((key) => caches.delete(key)))
          }
          if ('serviceWorker' in navigator) {
            const registrations = await navigator.serviceWorker.getRegistrations()
            await Promise.all(registrations.map((reg) => reg.unregister()))
          }
        } catch {}
        
        const cleanUrl = window.location.origin + window.location.pathname
        window.location.replace(`${cleanUrl}?_reload=${Date.now()}`)
      }
    } catch {
      // Bỏ qua lỗi kết nối tạm thời khi offline
    }
  }

  // 1. Kiểm tra 2s sau khi mở app
  window.addEventListener('load', () => {
    setTimeout(checkForUpdate, 2000)
  })

  // 2. Kiểm tra khi người dùng mở lại app / active tab
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      void checkForUpdate()
    }
  })

  // 3. Kiểm tra khi có mạng trở lại
  window.addEventListener('online', () => {
    void checkForUpdate()
  })

  // 4. Định kỳ kiểm tra mỗi 60 giây khi app đang chạy
  setInterval(checkForUpdate, 60000)
}

if (import.meta.env.PROD) {
  initVersionWatcher()
}
