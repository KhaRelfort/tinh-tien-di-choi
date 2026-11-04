import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react(), {
    name: 'emit-offline-service-worker',
    generateBundle(_options, bundle) {
      const assets = Object.keys(bundle).filter((name) => name.startsWith('assets/') && /\.(js|css)$/.test(name)).map((name) => `/${name}`)
      const cacheVersion = assets.join('|').split('').reduce((hash, char) => (hash * 31 + char.charCodeAt(0)) >>> 0, 7).toString(36)
      const cacheName = `chia-tien-shell-${cacheVersion}`
      const source = `const CACHE_NAME=${JSON.stringify(cacheName)};\nconst SHELL_URLS=['/','/manifest.webmanifest','/icon.svg','/apple-touch-icon.png',${assets.map((asset) => JSON.stringify(asset)).join(',')}];\nself.addEventListener('install',event=>{event.waitUntil(caches.open(CACHE_NAME).then(cache=>cache.addAll(SHELL_URLS)).then(()=>self.skipWaiting()))});\nself.addEventListener('activate',event=>{event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(key=>key.startsWith('chia-tien-shell-')&&key!==CACHE_NAME).map(key=>caches.delete(key)))).then(()=>self.clients.claim()))});\nself.addEventListener('fetch',event=>{const request=event.request;if(request.method!=='GET'||new URL(request.url).origin!==self.location.origin)return;if(request.mode==='navigate'){event.respondWith(fetch(request).then(response=>{const copy=response.clone();void caches.open(CACHE_NAME).then(cache=>cache.put('/',copy));return response}).catch(async()=>await caches.match('/')||Response.error()));return}if(['script','style','image','font'].includes(request.destination)){event.respondWith(caches.match(request).then(cached=>cached||fetch(request).then(response=>{if(response.ok)void caches.open(CACHE_NAME).then(cache=>cache.put(request,response.clone()));return response})))}});\n`
      this.emitFile({ type: 'asset', fileName: 'sw.js', source })
    },
  }],
})
