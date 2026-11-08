/**
 * Усиленное шумоподавление микрофона: DeepFilterNet3 + речевой шлюз (см. pipeline.ts).
 * Звук идёт через Insertable Streams (MediaStreamTrackProcessor/Generator) в отдельный воркер.
 * Файлы нейросети (≈22 МБ) загружаются только при первом включении и переиспользуются.
 */
import DenoiseWorker from './denoise.worker?worker&inline'
import type { DenoiseCommand, DenoiseInit, DenoiseMessage } from './denoise.worker'
import dfnModelUrl from './dfn/DeepFilterNet3_onnx.tar.gz?url'
import dfnWasmUrl from './dfn/df_bg.wasm?url'
import type { DenoiseEngine } from './pipeline'

declare class MediaStreamTrackProcessor {
  constructor(init: { track: MediaStreamTrack })
  readonly readable: ReadableStream<AudioData>
}
declare class MediaStreamTrackGenerator extends MediaStreamTrack {
  constructor(init: { kind: 'audio' | 'video' })
  readonly writable: WritableStream<AudioData>
}

export interface DenoisedTrack {
  track: MediaStreamTrack
  /** Что реально работает: dfn — нейросеть DeepFilterNet3, rnnoise — упрощённый режим, none — только порог. */
  engine: DenoiseEngine
  /** Сменить чувствительность микрофона на ходу. */
  setThreshold(db: number | null): void
  stop(): void
}

export interface DenoiseOptions {
  /** Убирать шум нейросетью (иначе дорожка идёт через воркер только ради порога чувствительности). */
  denoise: boolean
  thresholdDb: number | null
}

export interface DenoiseHooks {
  /** Нейросеть отключилась на ходу (ошибка или слабый процессор) — дальше упрощённый режим. */
  onFallback(reason: 'error' | 'overload' | 'load'): void
}

const READY_TIMEOUT_MS = 15_000

export function denoiseSupported(): boolean {
  const g = globalThis as Record<string, unknown>
  return (
    typeof g.MediaStreamTrackProcessor === 'function' &&
    typeof g.MediaStreamTrackGenerator === 'function' &&
    typeof g.AudioData === 'function' &&
    typeof WebAssembly === 'object'
  )
}

/** Файл приложения целиком. В Electron страница открыта с диска (file://) — там fetch может быть недоступен, пробуем XHR. */
async function loadBytes(url: string): Promise<ArrayBuffer> {
  try {
    const res = await fetch(url)
    if (!res.ok && res.status !== 0) throw new Error(`HTTP ${res.status}`)
    const buf = await res.arrayBuffer()
    if (buf.byteLength === 0) throw new Error('пустой ответ')
    return buf
  } catch (err) {
    return await new Promise<ArrayBuffer>((resolve, reject) => {
      const xhr = new XMLHttpRequest()
      xhr.open('GET', url)
      xhr.responseType = 'arraybuffer'
      xhr.onload = () => {
        const buf = xhr.response as ArrayBuffer | null
        if (buf && buf.byteLength > 0) resolve(buf)
        else reject(err)
      }
      xhr.onerror = () => reject(err)
      xhr.send()
    })
  }
}

/** Модель должна дойти в gzip. Если сервер или прокси распаковали её по пути — упаковываем обратно. */
async function ensureGzip(data: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  if (data[0] === 0x1f && data[1] === 0x8b) return data
  const packed = new Blob([data]).stream().pipeThrough(new CompressionStream('gzip'))
  return new Uint8Array(await new Response(packed).arrayBuffer())
}

type DfnAssets = NonNullable<DenoiseInit['dfn']>
let dfnAssets: Promise<DfnAssets> | null = null

/** Загружает и компилирует нейросеть один раз; при ошибке следующая попытка начнёт заново. */
function loadDfn(): Promise<DfnAssets> {
  dfnAssets ??= (async () => {
    const [wasm, model] = await Promise.all([loadBytes(dfnWasmUrl), loadBytes(dfnModelUrl)])
    return { module: await WebAssembly.compile(wasm), model: await ensureGzip(new Uint8Array(model)) }
  })().catch((err) => {
    dfnAssets = null
    throw err
  })
  return dfnAssets
}

/** Заранее загрузить нейросеть (например, при открытии настроек), чтобы вход в канал не ждал. */
export function preloadDenoise(): void {
  if (denoiseSupported()) loadDfn().catch(() => undefined)
}

/** Возвращает очищенную дорожку; при ошибке бросает исключение (вызывающий оставляет исходную). */
export async function createDenoisedTrack(source: MediaStreamTrack, hooks: DenoiseHooks, options: DenoiseOptions): Promise<DenoisedTrack> {
  if (!denoiseSupported()) throw new Error('Insertable Streams недоступны')

  let dfn: DfnAssets | null = null
  if (options.denoise) {
    try {
      dfn = await loadDfn()
    } catch (err) {
      console.warn('[voice] DeepFilterNet не загрузился, шумоподавление работает на RNNoise', err)
    }
  }

  const processor = new MediaStreamTrackProcessor({ track: source })
  const generator = new MediaStreamTrackGenerator({ kind: 'audio' })
  const worker = new DenoiseWorker()

  let engine: DenoiseEngine
  try {
    engine = await new Promise<DenoiseEngine>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('шумоподавление не запустилось вовремя')), READY_TIMEOUT_MS)
      worker.onmessage = (e: MessageEvent<DenoiseMessage>) => {
        const msg = e.data
        if (msg.type === 'ready') {
          clearTimeout(timer)
          if (msg.note) console.warn('[voice] DeepFilterNet не запустился:', msg.note)
          resolve(msg.engine)
        } else if (msg.type === 'error') {
          clearTimeout(timer)
          reject(new Error(msg.message))
        } else {
          console.warn(`[voice] DeepFilterNet отключён (${msg.reason}): ${msg.message}`)
          hooks.onFallback(msg.reason)
        }
      }
      worker.onerror = (e) => {
        clearTimeout(timer)
        reject(new Error(e.message || 'ошибка воркера шумоподавления'))
      }
      const init: DenoiseInit = { readable: processor.readable, writable: generator.writable, dfn, denoise: options.denoise, thresholdDb: options.thresholdDb }
      worker.postMessage(init, [processor.readable as unknown as Transferable, generator.writable as unknown as Transferable])
    })
  } catch (err) {
    worker.terminate()
    generator.stop()
    throw err
  }

  return {
    track: generator,
    engine,
    setThreshold(db) {
      const cmd: DenoiseCommand = { type: 'threshold', db }
      worker.postMessage(cmd)
    },
    stop() {
      worker.terminate()
      generator.stop()
      source.stop()
    }
  }
}
