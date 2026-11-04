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

// NOTE(VI): Lý do: Gỡ bỏ Service Worker khi chạy local dev để tránh cache làm phiền.
// Lưu ý: Không được gọi window.location.reload() ở đây vì sẽ gây vòng lặp reload vô tận ở localhost!
if (import.meta.env.DEV && 'serviceWorker' in navigator) {
  void navigator.serviceWorker.getRegistrations().then(async (registrations) => {
    await Promise.all(registrations.map((registration) => registration.unregister()))
  })
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

      if (latestVersion && latestVersion !== __APP_VERSION__) {
        isUpdating = true
        console.log(`[Update] Phát hiện phiên bản mới: v${latestVersion} (hiện tại v${__APP_VERSION__}). Đang tự động cập nhật...`)
        
        if ('serviceWorker' in navigator) {
          const registrations = await navigator.serviceWorker.getRegistrations()
          for (const reg of registrations) {
            await reg.update()
          }
        }
        
        window.location.reload()
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

if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' })
  })
}
