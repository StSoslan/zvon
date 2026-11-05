import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { buildId } from './build-id'

const shared = { '@shared': resolve(__dirname, 'src/shared') }

/**
 * Вариант сборки (переменные окружения при `npm run build` / `npm run dist`):
 * - ZVON_EDITION=online — версия для сервера в интернете (VPS): без вкладки «Стать хостом»;
 *   lan (по умолчанию) — полная версия с хостингом на своём компьютере.
 * - ZVON_SERVER=адрес[:порт] — сервер, подставляемый в поле адреса при первом запуске.
 */
const edition = process.env.ZVON_EDITION === 'online' ? 'online' : 'lan'
const defaultServer = (process.env.ZVON_SERVER ?? '').trim()

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: shared },
    build: {
      rollupOptions: {
        // Две точки входа: main-процесс и встроенный сервер хоста (utilityProcess).
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          server: resolve(__dirname, 'src/server/index.ts')
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: shared }
  },
  renderer: {
    resolve: {
      alias: {
        ...shared,
        '@renderer': resolve(__dirname, 'src/renderer/src')
      }
    },
    plugins: [react()],
    define: {
      __ZVON_EDITION__: JSON.stringify(edition),
      __ZVON_DEFAULT_SERVER__: JSON.stringify(defaultServer),
      __ZVON_WEB__: 'false',
      __ZVON_VERSION__: JSON.stringify(process.env.npm_package_version ?? ''),
      __ZVON_BUILD__: JSON.stringify(buildId())
    }
  }
})
