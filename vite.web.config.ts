/**
 * Веб-версия (браузер на компьютере и телефоне): тот же интерфейс, что в приложении,
 * но вместо Electron — src/renderer/src/web/api.ts. Сборка: npm run build:web → out/web,
 * эти файлы раздаёт сам сервер Zvon.
 */
import { resolve } from 'node:path'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import pkg from './package.json'
import { buildId } from './build-id'

/** Теги для телефонов и установки на главный экран — только в веб-версии. */
const webHead: Plugin = {
  name: 'zvon-web-head',
  transformIndexHtml: () => [
    { tag: 'link', attrs: { rel: 'manifest', href: '/manifest.webmanifest' }, injectTo: 'head' },
    { tag: 'link', attrs: { rel: 'icon', href: '/icon.png' }, injectTo: 'head' },
    { tag: 'link', attrs: { rel: 'apple-touch-icon', href: '/icon.png' }, injectTo: 'head' },
    { tag: 'meta', attrs: { name: 'theme-color', content: '#1e1f22' }, injectTo: 'head' },
    { tag: 'meta', attrs: { name: 'apple-mobile-web-app-capable', content: 'yes' }, injectTo: 'head' },
    { tag: 'meta', attrs: { name: 'mobile-web-app-capable', content: 'yes' }, injectTo: 'head' }
  ]
}

export default defineConfig({
  root: resolve(__dirname, 'src/renderer'),
  base: '/',
  publicDir: resolve(__dirname, 'src/renderer/web-public'),
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared'),
      '@renderer': resolve(__dirname, 'src/renderer/src')
    }
  },
  plugins: [react(), webHead],
  define: {
    __ZVON_EDITION__: JSON.stringify('online'),
    __ZVON_DEFAULT_SERVER__: JSON.stringify(''),
    __ZVON_WEB__: 'true',
    __ZVON_VERSION__: JSON.stringify(pkg.version),
    __ZVON_BUILD__: JSON.stringify(buildId())
  },
  build: {
    outDir: resolve(__dirname, 'out/web'),
    emptyOutDir: true
  }
})
