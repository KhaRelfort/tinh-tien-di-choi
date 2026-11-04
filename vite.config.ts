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

const appVersion = getAppVersion()

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(appVersion),
  },
  plugins: [react(), {
    name: 'emit-offline-service-worker',
    generateBundle(_options, bundle) {
      const assets = Object.keys(bundle).filter((name) => name.startsWith('assets/') && /\.(js|css)$/.test(name)).map((name) => `/${name}`)
      const cacheName = `chia-tien-shell-v${appVersion}`
      const versionFileContent = fs.existsSync('version.js') ? fs.readFileSync('version.js', 'utf8') : `export const APP_VERSION = '${appVersion}';`
      
      const source = `const CACHE_NAME=${JSON.stringify(cacheName)};\nconst SHELL_URLS=['/','/manifest.webmanifest','/icon.svg','/apple-touch-icon.png',${assets.map((asset) => JSON.stringify(asset)).join(',')}];\nself.addEventListener('install',event=>{event.waitUntil(caches.open(CACHE_NAME).then(cache=>cache.addAll(SHELL_URLS)).then(()=>self.skipWaiting()))});\nself.addEventListener('activate',event=>{event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(key=>key.startsWith('chia-tien-shell-')&&key!==CACHE_NAME).map(key=>caches.delete(key)))).then(()=>self.clients.claim()))});\nself.addEventListener('fetch',event=>{const request=event.request;if(request.method!=='GET'||new URL(request.url).origin!==self.location.origin)return;if(request.url.includes('version.js'))return;if(request.mode==='navigate'){event.respondWith(fetch(request).then(response=>{const copy=response.clone();void caches.open(CACHE_NAME).then(cache=>cache.put('/',copy));return response}).catch(async()=>await caches.match('/')||Response.error()));return}if(['script','style','image','font'].includes(request.destination)){event.respondWith(caches.match(request).then(cached=>cached||fetch(request).then(response=>{if(response.ok)void caches.open(CACHE_NAME).then(cache=>cache.put(request,response.clone()));return response})))}});\n`
      this.emitFile({ type: 'asset', fileName: 'sw.js', source })
      this.emitFile({ type: 'asset', fileName: 'version.js', source: versionFileContent })
    },
  }],
})
