import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
// @ts-ignore
import fs from 'fs'

function getAppVersion(): string {
  try {
    const content = fs.readFileSync('version.js', 'utf8')
    const match = content.match(/APP_VERSION\s*=\s*['"]([^'"]+)['"]/)
    return match ? match[1] : '1.0.0'
  } catch {
    return '1.0.0'
  }
}

// NOTE(VI): Lý do: Đồng bộ 2 chiều giữa version.js (gốc) và public/version.js theo thời gian sửa mới nhất (mtimeMs)
// Trước: Chỉ chép 1 chiều từ version.js (gốc) đè sang public/version.js -> khi người dùng mở tab public/version.js để sửa (vd lên 2.2, 2.5) thì bị ghi đè ngược lại thành 2.1 của file gốc
// Sau: Kiểm tra mtimeMs của 2 file, file nào vừa được người dùng lưu mới hơn sẽ tự động đồng bộ sang file kia (chỉ ghi khi nội dung khác nhau)
// Test: Sửa version ở bất kỳ file nào (version.js gốc hoặc public/version.js) -> cả 2 file đều giữ đúng số version mới nhất, không bao giờ bị tự nhảy về số cũ
function syncVersionFile() {
  try {
    const rootPath = 'version.js'
    const publicPath = 'public/version.js'
    const hasRoot = fs.existsSync(rootPath)
    const hasPublic = fs.existsSync(publicPath)

    if (hasRoot && hasPublic) {
      const rootContent = fs.readFileSync(rootPath, 'utf8')
      const publicContent = fs.readFileSync(publicPath, 'utf8')
      if (rootContent !== publicContent) {
        const rootStat = fs.statSync(rootPath)
        const publicStat = fs.statSync(publicPath)
        if (publicStat.mtimeMs > rootStat.mtimeMs) {
          fs.writeFileSync(rootPath, publicContent, 'utf8')
        } else {
          fs.writeFileSync(publicPath, rootContent, 'utf8')
        }
      }
    } else if (hasRoot && fs.existsSync('public')) {
      fs.writeFileSync(publicPath, fs.readFileSync(rootPath, 'utf8'), 'utf8')
    } else if (hasPublic) {
      fs.writeFileSync(rootPath, fs.readFileSync(publicPath, 'utf8'), 'utf8')
    }
  } catch { /* ignore */ }
}

syncVersionFile()

const appVersion = getAppVersion()

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(appVersion),
  },
  plugins: [
    react(),
    {
      name: 'version-sync-and-serve',
      configureServer(server) {
        server.middlewares.use((req: any, res, next) => {
          if (req.url && req.url.startsWith('/version.js')) {
            syncVersionFile()
            const content = fs.existsSync('version.js')
              ? fs.readFileSync('version.js', 'utf8')
              : `export const APP_VERSION = '${getAppVersion()}';`
            res.setHeader('Content-Type', 'application/javascript')
            res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate')
            res.end(content)
            return
          }
          next()
        })
      },
      generateBundle(_options, bundle) {
        syncVersionFile()
        const latestAppVersion = getAppVersion()
        const assets = Object.keys(bundle).filter((name) => name.startsWith('assets/') && /\.(js|css)$/.test(name)).map((name) => `/${name}`)
        const cacheName = `chia-tien-shell-v${latestAppVersion}`
        const versionFileContent = fs.existsSync('version.js') ? fs.readFileSync('version.js', 'utf8') : `export const APP_VERSION = '${latestAppVersion}';`
        
        const source = `const CACHE_NAME=${JSON.stringify(cacheName)};\nconst SHELL_URLS=['/','/manifest.webmanifest','/icon.svg','/apple-touch-icon.png',${assets.map((asset) => JSON.stringify(asset)).join(',')}];\nself.addEventListener('install',event=>{event.waitUntil(caches.open(CACHE_NAME).then(cache=>cache.addAll(SHELL_URLS)).then(()=>self.skipWaiting()))});\nself.addEventListener('activate',event=>{event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(key=>key.startsWith('chia-tien-shell-')&&key!==CACHE_NAME).map(key=>caches.delete(key)))).then(()=>self.clients.claim()))});\nself.addEventListener('fetch',event=>{const request=event.request;if(request.method!=='GET'||new URL(request.url).origin!==self.location.origin)return;if(request.url.includes('version.js'))return;if(request.mode==='navigate'){event.respondWith(fetch(request).then(response=>{const copy=response.clone();void caches.open(CACHE_NAME).then(cache=>cache.put('/',copy));return response}).catch(async()=>await caches.match('/')||Response.error()));return}if(['script','style','image','font'].includes(request.destination)){event.respondWith(caches.match(request).then(cached=>cached||fetch(request).then(response=>{if(response.ok)void caches.open(CACHE_NAME).then(cache=>cache.put(request,response.clone()));return response})))}});\n`
        this.emitFile({ type: 'asset', fileName: 'sw.js', source })
        this.emitFile({ type: 'asset', fileName: 'version.js', source: versionFileContent })
      },
    },
  ],
})
