/**
 * Речевой шлюз: пропускает звук только пока идёт речь (плюс короткий «хвост»),
 * в остальное время отдаёт полную тишину. Добивает то, что нейросеть не убрала до конца:
 * одиночные щелчки, стук, шорохи между фразами.
 *
 * Звук задерживается на lookahead кадров: шлюз успевает открыться до начала слова и не съедает первый слог.
 */
export interface GateOptions {
  /** Вероятность речи (детектор), при которой закрытый шлюз открывается. */
  openVad: number
  /** Пока шлюз открыт, речь считается продолжающейся при вероятности не ниже этой. */
  closeVad: number
  /** Громкость кадра (rms, 0…1), которая открывает шлюз сама по себе; Infinity — не учитывать громкость. */
  openLevel: number
  /** Громкость кадра, которая удерживает шлюз открытым. */
  closeLevel: number
  /** Сколько кадров держать шлюз открытым после последнего кадра с речью. */
  holdFrames: number
  /** Задержка звука в кадрах (упреждение открытия). */
  lookaheadFrames: number
  /** За сколько кадров шлюз плавно закрывается. */
  releaseFrames: number
}

const db = (value: number): number => 10 ** (value / 20)

/**
 * Кадр — 10 мс. Хвост 450 мс покрывает паузы между словами, упреждение 30 мс — начало слова.
 *
 * После DeepFilterNet в шлюз приходит уже очищенный звук: шум и стук в нём тише −50 дБ, и детектор
 * речи на них молчит. А вот шипящее начало слова («с» в «спасибо») детектор узнаёт неуверенно,
 * хотя нейросеть его сохранила. Поэтому шлюз открывается и по детектору (низкий порог), и просто
 * по громкости: ложное открытие почти ничего не стоит (пройдёт лишь остаток после нейросети),
 * а съеденный слог слышен сразу.
 */
export const GATE_AFTER_DFN: GateOptions = {
  openVad: 0.25,
  closeVad: 0.15,
  openLevel: db(-38),
  closeLevel: db(-45),
  holdFrames: 45,
  lookaheadFrames: 3,
  releaseFrames: 8
}

/**
 * Упрощённый режим (только RNNoise) и разогрев нейросети в первую секунду: стук в звуке ещё остаётся,
 * поэтому шлюз верит только уверенному срабатыванию детектора речи.
 */
export const GATE_STRICT: GateOptions = {
  ...GATE_AFTER_DFN,
  openVad: 0.6,
  closeVad: 0.35,
  openLevel: Infinity,
  closeLevel: Infinity
}

/** Шлюз только по громкости (без детектора речи): для чувствительности микрофона без шумоподавления. */
export const GATE_LEVEL_ONLY: GateOptions = {
  ...GATE_AFTER_DFN,
  openVad: Infinity,
  closeVad: Infinity,
  openLevel: Infinity,
  closeLevel: Infinity
}

export class SpeechGate {
  private opts: GateOptions
  private readonly delay: Float32Array[] = []
  private hold = 0
  private gain = 0
  /** Чувствительность микрофона: тише этого уровня (rms, 0…1) речью не считается; null — не ограничивать. */
  private minLevel: number | null = null

  constructor(opts: GateOptions) {
    this.opts = opts
  }

  /** Порог чувствительности в дБFS (например −50); null — авто. */
  setThreshold(dbfs: number | null): void {
    this.minLevel = dbfs === null ? null : db(dbfs)
  }

  /** Сменить пороги на лету (упреждение менять нельзя — от него зависит задержка звука). */
  setOptions(opts: GateOptions): void {
    this.opts = { ...opts, lookaheadFrames: this.opts.lookaheadFrames }
  }

  /**
   * @param frame очищенный кадр
   * @param vad   вероятность речи в этом кадре, 0…1
   * @returns кадр, задержанный на lookahead, с применённым шлюзом (новый массив)
   */
  process(frame: Float32Array, vad: number): Float32Array {
    const o = this.opts
    const open = this.hold > 0
    let rms = -1
    const level = (): number => {
      if (rms < 0) {
        let sum = 0
        for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i]
        rms = Math.sqrt(sum / frame.length)
      }
      return rms
    }
    let speech = vad >= (open ? o.closeVad : o.openVad)
    if (!speech && Number.isFinite(o.openLevel)) speech = level() >= (open ? o.closeLevel : o.openLevel)
    // Порог чувствительности: пока открыт, отпускаем чуть ниже порога, чтобы не дробить фразу.
    const levelOnly = !Number.isFinite(o.openVad) && !Number.isFinite(o.openLevel)
    if (this.minLevel === null) {
      if (levelOnly) speech = true
    } else if (level() < (open ? this.minLevel * 0.5 : this.minLevel)) speech = false
    else if (levelOnly) speech = true
    if (speech) this.hold = o.holdFrames
    else if (open) this.hold--

    this.delay.push(frame)
    const out = new Float32Array(frame.length)
    if (this.delay.length <= o.lookaheadFrames) return out
    const src = this.delay.shift() as Float32Array

    const from = this.gain
    const to = this.hold > 0 ? 1 : Math.max(0, from - 1 / o.releaseFrames)
    this.gain = to
    if (from === 0 && to === 0) return out
    if (from === 1 && to === 1) {
      out.set(src)
      return out
    }
    // Плавный переход внутри кадра — без щелчка на границе.
    const step = (to - from) / src.length
    for (let i = 0; i < src.length; i++) out[i] = src[i] * (from + step * (i + 1))
    return out
  }
}
