import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
// @ts-ignore
import fs from 'fs'

// NOTE(VI): Lý do: Giữ DUY NHẤT 1 file version là public/version.js theo đúng chuẩn Vite.
// Trước: Có 2 file (version.js ở gốc và public/version.js) -> gây lỗi lệch phiên bản, Vercel luôn lấy file cũ đè lên file mới làm điện thoại bị tụt 1 bản.
// Sau: Chỉ dùng 1 file duy nhất public/version.js làm nguồn chân lý, xóa bỏ file version.js thừa ở gốc.
// Test: Sửa số version trong public/version.js -> localhost và Vercel luôn ra đúng 100% số version vừa sửa.
function getAppVersion(): string {
  try {
    const content = fs.readFileSync('public/version.js', 'utf8')
    const match = content.match(/APP_VERSION\s*=\s*['"]([^'"]+)['"]/)
    return match ? match[1] : '1.0.0'
  } catch {
    return '1.0.0'
  }
}

const appVersion = getAppVersion()

// NOTE(VI): Lý do: Tạo mã nguồn Service Worker (sw.js) dùng chiến lược Network-First + Offline Cache Fallback cho cả môi trường DEV (localhost) và PROD
// Trước: Chỉ tạo sw.js khi build PROD (ở localhost dev bị unregister nên bật Offline trong DevTools bấm F5 là bị lỗi khủng long ERR_INTERNET_DISCONNECTED); chưa cache /version.js
// Sau: Khi có mạng luôn ưu tiên lấy bản mới nhất từ mạng và lưu vào CacheStorage; khi mất mạng (offline) tự động trả về toàn bộ HTML/JS/CSS/version.js từ CacheStorage
// Test: Mở app -> chuyển Network sang Offline trong Chrome DevTools hoặc tắt Wi-Fi trên điện thoại -> bấm F5 tải lại trang -> App vẫn mở lên bình thường, không bị màn hình khủng long mất mạng
function createServiceWorkerSource(cacheName: string, shellUrls: string[]): string {
  return `const CACHE_NAME=${JSON.stringify(cacheName)};
const SHELL_URLS=${JSON.stringify(shellUrls)};
self.addEventListener('install',event=>{
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache=>Promise.allSettled(SHELL_URLS.map(url=>cache.add(url))))
      .then(()=>self.skipWaiting())
  );
});
self.addEventListener('activate',event=>{
  event.waitUntil(
    caches.keys()
      .then(keys=>Promise.all(keys.filter(key=>key.startsWith('chia-tien-shell-')&&key!==CACHE_NAME).map(key=>caches.delete(key))))
      .then(()=>self.clients.claim())
  );
});
self.addEventListener('message',event=>{
  if(event.data&&event.data.type==='CACHE_URLS'&&Array.isArray(event.data.urls)){
    event.waitUntil(
      caches.open(CACHE_NAME).then(cache=>Promise.allSettled(
        event.data.urls.map(async url=>{
          try{
            const existing=await cache.match(url);
            if(!existing){
              const res=await fetch(url);
              if(res.ok)await cache.put(url,res);
            }
          }catch{}
        })
      ))
    );
  }
});
self.addEventListener('fetch',event=>{
  const request=event.request;
  if(request.method!=='GET')return;
  const url=new URL(request.url);
  const isSameOrigin=url.origin===self.location.origin;
  const isFontOrigin=url.origin==='https://fonts.googleapis.com'||url.origin==='https://fonts.gstatic.com';
  if(!isSameOrigin&&!isFontOrigin)return;
  if(url.pathname.startsWith('/__vite_ping')||url.pathname.startsWith('/@vite/client')){
    event.respondWith(
      fetch(request).catch(async()=>{
        const cached=await caches.match(request)||await caches.match(url.pathname,{ignoreSearch:true});
        return cached||new Response('export {}',{headers:{'Content-Type':'application/javascript'}});
      })
    );
    return;
  }
  if(request.mode==='navigate'){
    event.respondWith(
      fetch(request).then(response=>{
        if(response.ok){
          const copy=response.clone();
          void caches.open(CACHE_NAME).then(cache=>{
            void cache.put(request,copy.clone());
            void cache.put('/',copy);
          });
        }
        return response;
      }).catch(async()=>await caches.match(request)||await caches.match('/')||await caches.match('/index.html')||Response.error())
    );
    return;
  }
  event.respondWith(
    fetch(request).then(response=>{
      if(response.ok){
        const copy=response.clone();
        void caches.open(CACHE_NAME).then(cache=>{
          void cache.put(request,copy);
          if(url.pathname==='/version.js'){
            void cache.put('/version.js',response.clone());
          }
        });
      }
      return response;
    }).catch(async()=>{
      const exact=await caches.match(request);
      if(exact)return exact;
      const noQuery=await caches.match(url.pathname,{ignoreSearch:true});
      if(noQuery)return noQuery;
      if(url.pathname==='/version.js'){
        return new Response("export const APP_VERSION = '1.0.0';",{headers:{'Content-Type':'application/javascript'}});
      }
      return Response.error();
    })
  );
});
`
}

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
            const content = fs.existsSync('public/version.js')
              ? fs.readFileSync('public/version.js', 'utf8')
              : `export const APP_VERSION = '${getAppVersion()}';`
            res.setHeader('Content-Type', 'application/javascript')
            res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate')
            res.end(content)
            return
          }
          if (req.url && req.url.startsWith('/sw.js')) {
            const latestAppVersion = getAppVersion()
            const cacheName = `chia-tien-shell-dev-v${latestAppVersion}`
            const shellUrls = ['/', '/version.js', '/manifest.webmanifest', '/icon.svg', '/apple-touch-icon.png', '/qr-payment.jpg', '/src/main.tsx', '/src/App.tsx', '/src/styles.css', '/src/phone.css']
            res.setHeader('Content-Type', 'application/javascript')
            res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate')
            res.end(createServiceWorkerSource(cacheName, shellUrls))
            return
          }
          next()
        })
      },
      generateBundle(_options, bundle) {
        const latestAppVersion = getAppVersion()
        const assets = Object.keys(bundle).filter((name) => name.startsWith('assets/') && /\.(js|css)$/.test(name)).map((name) => `/${name}`)
        const cacheName = `chia-tien-shell-v${latestAppVersion}`
        const shellUrls = ['/', '/version.js', '/manifest.webmanifest', '/icon.svg', '/apple-touch-icon.png', '/qr-payment.jpg', ...assets]
        const source = createServiceWorkerSource(cacheName, shellUrls)
        this.emitFile({ type: 'asset', fileName: 'sw.js', source })
      },
    },
  ],
})
