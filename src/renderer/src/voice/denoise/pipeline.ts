/**
 * Цепочка шумоподавления для одного кадра (480 сэмплов, 10 мс при 48 кГц):
 *   DeepFilterNet3 (нейросеть, убирает шум и стук клавиатуры даже поверх речи)
 *   → детектор речи RNNoise → речевой шлюз (тишина между фразами).
 * Если DeepFilterNet недоступен или не тянет процессор, шум убирает сам RNNoise (упрощённый режим).
 *
 * Без DOM: работает в воркере и в Node.
 */
import createRNNWasmModuleSync from '@jitsi/rnnoise-wasm/dist/rnnoise-sync.js'
import type { DeepFilter } from './dfn'
import { GATE_AFTER_DFN, GATE_LEVEL_ONLY, GATE_STRICT, SpeechGate } from './gate'

export const FRAME = 480
export const SAMPLE_RATE = 48000

/** none — шум не убираем, работает только порог чувствительности микрофона. */
export type DenoiseEngine = 'dfn' | 'rnnoise' | 'none'

export interface PipelineOptions {
  /** Убирать шум (DeepFilterNet или RNNoise); false — только шлюз по громкости. */
  denoise: boolean
  /** Чувствительность микрофона, дБFS; null — авто. */
  thresholdDb: number | null
  /** false — шлюз только задерживает звук, но не закрывается (для проверок). */
  useGate?: boolean
}

/** Первую секунду нейросеть «разогревается» и пропускает часть стука — шлюз в это время строгий. */
const WARMUP_FRAMES = 100

interface RnnoiseModule {
  _malloc(bytes: number): number
  _free(ptr: number): void
  _rnnoise_create(): number
  _rnnoise_destroy(state: number): void
  _rnnoise_process_frame(state: number, out: number, input: number): number
  HEAPF32: Float32Array
}

/** RNNoise: шумоподавление попроще и детектор речи (вероятность голоса в кадре). */
class Rnnoise {
  private readonly mod: RnnoiseModule
  private readonly state: number
  private readonly ptr: number
  private readonly index: number

  constructor() {
    this.mod = createRNNWasmModuleSync() as unknown as RnnoiseModule
    this.state = this.mod._rnnoise_create()
    this.ptr = this.mod._malloc(FRAME * 4)
    this.index = this.ptr >> 2
  }

  /** Обрабатывает кадр; out заполняется очищенным звуком. Возвращает вероятность речи 0…1. */
  process(frame: Float32Array, out: Float32Array | null): number {
    // RNNoise ждёт амплитуду как у 16-битного звука.
    const heap = this.mod.HEAPF32
    for (let i = 0; i < FRAME; i++) heap[this.index + i] = frame[i] * 32768
    const vad = this.mod._rnnoise_process_frame(this.state, this.ptr, this.ptr)
    if (out) {
      const h = this.mod.HEAPF32
      for (let i = 0; i < FRAME; i++) out[i] = h[this.index + i] / 32768
    }
    return vad
  }

  destroy(): void {
    try {
      this.mod._free(this.ptr)
      this.mod._rnnoise_destroy(this.state)
    } catch {
      /* ignore */
    }
  }
}

export class DenoisePipeline {
  private dfn: DeepFilter | null
  private readonly rnnoise = new Rnnoise()
  private readonly gate: SpeechGate
  private readonly useGate: boolean
  private readonly denoise: boolean
  private frames = 0

  /** dfn = null при denoise — упрощённый режим (только RNNoise). */
  constructor(dfn: DeepFilter | null, opts: PipelineOptions) {
    if (dfn && dfn.frameLength !== FRAME) throw new Error(`DeepFilterNet: неожиданный размер кадра ${dfn.frameLength}`)
    this.dfn = opts.denoise ? dfn : null
    this.denoise = opts.denoise
    this.useGate = opts.useGate ?? true
    this.gate = new SpeechGate(opts.denoise ? GATE_STRICT : GATE_LEVEL_ONLY)
    this.gate.setThreshold(opts.thresholdDb)
  }

  get engine(): DenoiseEngine {
    return this.dfn ? 'dfn' : this.denoise ? 'rnnoise' : 'none'
  }

  setThreshold(thresholdDb: number | null): void {
    this.gate.setThreshold(thresholdDb)
  }

  /** Отказаться от DeepFilterNet (ошибка или слабый процессор) и продолжить на RNNoise. */
  dropDfn(): void {
    try {
      this.dfn?.destroy()
    } catch {
      /* ignore */
    }
    this.dfn = null
    this.gate.setOptions(GATE_STRICT)
  }

  /** Кадр из FRAME сэмплов (−1…1) → очищенный кадр той же длины (с задержкой 30–60 мс). */
  process(frame: Float32Array): Float32Array {
    let clean: Float32Array
    let vad: number
    if (!this.denoise) {
      clean = frame
      vad = 1
    } else if (this.dfn) {
      if (++this.frames === WARMUP_FRAMES) this.gate.setOptions(GATE_AFTER_DFN)
      clean = this.dfn.process(frame)
      // Детектор слушает уже очищенный звук: стук и шум до него не доходят.
      vad = this.rnnoise.process(clean, null)
    } else {
      clean = new Float32Array(FRAME)
      vad = this.rnnoise.process(frame, clean)
    }
    return this.gate.process(clean, this.useGate ? vad : 1)
  }

  destroy(): void {
    this.dropDfn()
    this.rnnoise.destroy()
  }
}

/**
 * Приводит входной звук к 48 кГц (линейная интерполяция). Нужен редко: обычно браузер
 * уже отдаёт 48 кГц, но некоторые устройства работают на 44,1 или 96 кГц.
 */
export class Resampler {
  private readonly ratio: number
  /** Позиция следующего выходного сэмпла во входных сэмплах относительно начала текущего блока. */
  private pos = 0
  private last = 0

  constructor(inputRate: number, outputRate = SAMPLE_RATE) {
    this.ratio = inputRate / outputRate
  }

  process(input: Float32Array): Float32Array {
    const n = input.length
    if (n === 0) return input
    const out = new Float32Array(Math.ceil((n - this.pos) / this.ratio) + 1)
    let count = 0
    let pos = this.pos
    while (pos < n) {
      const i = Math.floor(pos)
      const frac = pos - i
      // Сэмпл «перед началом блока» — последний сэмпл предыдущего.
      const a = i === 0 ? this.last : input[i - 1]
      out[count++] = a + (input[i] - a) * frac
      pos += this.ratio
    }
    this.pos = pos - n
    this.last = input[n - 1]
    return out.subarray(0, count)
  }
}
