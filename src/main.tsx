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

if (import.meta.env.DEV && 'serviceWorker' in navigator) {
  void navigator.serviceWorker.getRegistrations().then(async (registrations) => {
    const removed = await Promise.all(registrations.map((registration) => registration.unregister()))
    if (removed.some(Boolean)) window.location.reload()
  })
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode><AppErrorBoundary><App /></AppErrorBoundary></React.StrictMode>,
)

if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' })
  })
}
