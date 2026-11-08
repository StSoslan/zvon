/**
 * Воркер шумоподавления: получает звук микрофона (MediaStreamTrackProcessor), режет его на кадры
 * по 10 мс, пропускает через цепочку (pipeline.ts) и отдаёт в MediaStreamTrackGenerator.
 * Работает в отдельном потоке, чтобы не нагружать интерфейс.
 */
import { createDeepFilter } from './dfn'
import { DenoisePipeline, FRAME, Resampler, SAMPLE_RATE, type DenoiseEngine } from './pipeline'

export interface DenoiseInit {
  readable: ReadableStream<AudioData>
  writable: WritableStream<AudioData>
  /** Скомпилированный DeepFilterNet и его модель; null — работать только на RNNoise. */
  dfn: { module: WebAssembly.Module; model: Uint8Array } | null
  /** false — шум не убирать, только порог чувствительности. */
  denoise: boolean
  /** Чувствительность микрофона, дБFS; null — авто. */
  thresholdDb: number | null
}

/** Команды на ходу (после запуска). */
export type DenoiseCommand = { type: 'threshold'; db: number | null }

export type DenoiseMessage =
  | { type: 'ready'; engine: DenoiseEngine; note: string | null }
  /** DeepFilterNet отключён на ходу (ошибка или не хватает процессора) — дальше работает RNNoise. */
  | { type: 'fallback'; reason: 'error' | 'overload'; message: string }
  | { type: 'error'; message: string }

interface WorkerScope {
  onmessage: ((e: MessageEvent<DenoiseInit | DenoiseCommand>) => void) | null
  postMessage(message: DenoiseMessage): void
}

const ctx = self as unknown as WorkerScope

/** Очередь сэмплов (размеры маленькие, копирование дешёвое). */
class SampleQueue {
  private buf = new Float32Array(FRAME * 8)
  private len = 0

  get length(): number {
    return this.len
  }

  push(data: Float32Array): void {
    if (this.len + data.length > this.buf.length) {
      const next = new Float32Array(Math.max(this.buf.length * 2, this.len + data.length))
      next.set(this.buf.subarray(0, this.len))
      this.buf = next
    }
    this.buf.set(data, this.len)
    this.len += data.length
  }

  take(n: number): Float32Array {
    const out = this.buf.slice(0, n)
    this.buf.copyWithin(0, n, this.len)
    this.len -= n
    return out
  }
}

/** Кадр длится 10 мс. Если обработка в среднем занимает больше — процессор не успевает. */
const OVERLOAD_MS = 7
/** Сколько кадров подряд (≈3 с) усреднять, прежде чем признать перегрузку. */
const OVERLOAD_WINDOW = 300

let active: DenoisePipeline | null = null

ctx.onmessage = async (e: MessageEvent<DenoiseInit | DenoiseCommand>) => {
  if ('type' in e.data) {
    if (e.data.type === 'threshold') active?.setThreshold(e.data.db)
    return
  }
  const { readable, writable, dfn, denoise, thresholdDb } = e.data
  let pipeline: DenoisePipeline
  let note: string | null = null
  try {
    let filter = null
    if (dfn && denoise) {
      try {
        filter = await createDeepFilter(dfn.module, dfn.model)
      } catch (err) {
        note = (err as Error).message
      }
    }
    pipeline = new DenoisePipeline(filter, { denoise, thresholdDb })
    active = pipeline
  } catch (err) {
    ctx.postMessage({ type: 'error', message: (err as Error).message })
    return
  }

  const input = new SampleQueue()
  let resampler: Resampler | null = null
  let resamplerRate = 0
  /** Время следующего выходного кадра, мкс. */
  let timestamp: number | null = null
  let slowSum = 0
  let slowCount = 0

  const fallback = (reason: 'error' | 'overload', message: string): void => {
    if (pipeline.engine !== 'dfn') return
    pipeline.dropDfn()
    ctx.postMessage({ type: 'fallback', reason, message })
  }

  const transform = new TransformStream<AudioData, AudioData>({
    transform(data, controller) {
      const n = data.numberOfFrames
      let samples = new Float32Array(n)
      // Берём первый канал: микрофон запрашивается моно.
      data.copyTo(samples, { planeIndex: 0, format: 'f32-planar' })
      if (timestamp === null) timestamp = data.timestamp
      const rate = data.sampleRate
      data.close()

      if (rate !== SAMPLE_RATE) {
        if (!resampler || resamplerRate !== rate) {
          resampler = new Resampler(rate)
          resamplerRate = rate
        }
        samples = resampler.process(samples) as Float32Array<ArrayBuffer>
      }
      input.push(samples)

      while (input.length >= FRAME) {
        const frame = input.take(FRAME)
        let out: Float32Array
        const started = performance.now()
        try {
          out = pipeline.process(frame)
        } catch (err) {
          // Сбой нейросети не должен оставить человека без микрофона.
          fallback('error', (err as Error).message)
          out = pipeline.process(frame)
        }
        if (pipeline.engine === 'dfn') {
          slowSum += performance.now() - started
          if (++slowCount >= OVERLOAD_WINDOW) {
            if (slowSum / slowCount > OVERLOAD_MS) fallback('overload', `${(slowSum / slowCount).toFixed(1)} мс на кадр`)
            slowSum = 0
            slowCount = 0
          }
        }
        controller.enqueue(
          new AudioData({
            format: 'f32-planar',
            sampleRate: SAMPLE_RATE,
            numberOfFrames: FRAME,
            numberOfChannels: 1,
            timestamp,
            data: out as unknown as BufferSource
          })
        )
        timestamp += (FRAME / SAMPLE_RATE) * 1_000_000
      }
    }
  })

  ctx.postMessage({ type: 'ready', engine: pipeline.engine, note })
  try {
    await readable.pipeThrough(transform).pipeTo(writable)
  } catch {
    /* трек остановлен */
  } finally {
    pipeline.destroy()
  }
}
