/// <reference types="vite/client" />
import type { ZvonApi } from '../../preload/api'

declare global {
  const __ZVON_EDITION__: 'lan' | 'online'
  const __ZVON_DEFAULT_SERVER__: string
  const __ZVON_WEB__: boolean
  const __ZVON_VERSION__: string
  /** Метка сборки: короткий хеш коммита и время сборки. */
  const __ZVON_BUILD__: string
  interface Window {
    zvon: ZvonApi
  }
}

export {}
