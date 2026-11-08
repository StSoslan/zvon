/**
 * Медиадвижок клиента на mediasoup-client:
 * транспорты, микрофон, камера (VP8 simulcast), демонстрация экрана (VP9 SVC или VP8 simulcast)
 * и её звук; приём участников с паузой невидимого видео и выбором слоя качества;
 * mute/deafen/PTT, восстановление ICE и полный перезаход при сбоях.
 */
import { Device, types } from 'mediasoup-client'
import { BITRATE } from '../../../shared/constants'
import type { ConsumerInfo, MediaJson, MediaSource, ProducerInfo, RequestMap, RequestType, ResponseMap } from '../../../shared/types'
import { createDenoisedTrack, type DenoisedTrack } from './denoise'
import { diag, errText } from './diag'
import { effectiveNoiseMode, SCREEN_PRESETS, type ScreenContent, type ScreenQuality, type VoiceSettings } from './settings'

export type VoiceStatus = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'error'

export type Requester = <K extends RequestType>(type: K, data: RequestMap[K]) => Promise<ResponseMap[K]>

/** Видео собеседника для интерфейса. */
export interface RemoteVideoView {
  consumerId: string
  producerId: string
  userId: string
  source: 'camera' | 'screen'
  track: MediaStreamTrack
  spatialLayers: number
  /** Слой, который реально приходит сейчас (null — пауза или ещё неизвестно). */
  currentSpatial: number | null
  /** Ручной выбор качества (null — автоматически). */
  manualLayer: number | null
  /** Поток сейчас принимается (кто-то его смотрит). */
  active: boolean
  /** У этого пользователя есть звук демонстрации. */
  hasAudio: boolean
}

export interface LocalMedia {
  camera: MediaStreamTrack | null
  screen: MediaStreamTrack | null
  screenHasAudio: boolean
}

export interface EngineHooks {
  onStatus(status: VoiceStatus, error: string | null): void
  /** Проблема с микрофоном: в канале остаёмся, но без передачи голоса. */
  onMicError(message: string | null): void
  /** Система приглушила микрофон (true) или вернула его (false) — например, телефон отдал звук видео. */
  onMicInterrupted(interrupted: boolean): void
  /** Транспорт не восстановился — нужен полный перезаход в канал. */
  onFatalTransport(): void
  onVideos(videos: RemoteVideoView[]): void
  onLocalMedia(local: LocalMedia): void
}

export interface ScreenShareOptions {
  sourceId: string
  quality: ScreenQuality
  content: ScreenContent
  /** Звук системы средствами ОС (Windows, macOS 13+). */
  loopbackAudio: boolean
  /** Linux: id «Monitor»-устройства PulseAudio/PipeWire. */
  monitorDeviceId: string | null
}

interface RemoteAudio {
  consumer: types.Consumer
  userId: string
  source: MediaSource
  el: HTMLAudioElement
  /** Состояние паузы, которое мы последним выставили (чтобы не слать лишние запросы). */
  playing: boolean
  /** Усиление выше 100%: звук идёт через Web Audio, а элемент играет беззвучно. */
  boost: { source: MediaStreamAudioSourceNode; gain: GainNode } | null
}

/** Максимальная громкость участника и звука демонстрации (2 = 200%). */
export const MAX_VOLUME = 2

type SinkableContext = AudioContext & { setSinkId?: (id: string) => Promise<void> }

interface RemoteVideo {
  consumer: types.Consumer
  info: ConsumerInfo
  /** Кто смотрит: ключ зрителя (плитка, окно просмотра) → желаемый слой. */
  wants: Map<string, number>
  manualLayer: number | null
  active: boolean
  appliedLayer: number | null
  currentSpatial: number | null
}

type SinkableAudio = HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> }

/** Предупреждения об усиленном шумоподавлении, когда нейросеть не работает. */
const DENOISE_NOTICE = {
  load: 'Нейросеть шумоподавления не загрузилась — работает упрощённый режим',
  error: 'Нейросеть шумоподавления дала сбой — работает упрощённый режим',
  overload: 'Процессор не успевает за нейросетью шумоподавления — включён упрощённый режим'
} as const

const ICE_RESTART_DELAY_MS = 2_000
const MAX_ICE_RESTARTS = 3
const POPOUT_KEY = 'popout:'

/** Камера: три слоя simulcast (≈180p, 360p, 720p). */
const CAMERA_ENCODINGS = [
  { scaleResolutionDownBy: 4, maxBitrate: 150_000, scalabilityMode: 'L1T3' },
  { scaleResolutionDownBy: 2, maxBitrate: 500_000, scalabilityMode: 'L1T3' },
  { scaleResolutionDownBy: 1, maxBitrate: 1_500_000, scalabilityMode: 'L1T3' }
]

function mediaErrorText(err: unknown, what: 'микрофон' | 'камера' | 'экран'): string {
  const e = err as DOMException
  const noun = what === 'микрофон' ? 'микрофону' : what === 'камера' ? 'камере' : 'записи экрана'
  switch (e?.name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return what === 'экран' ? 'Демонстрация отменена или запрещена системой.' : `Нет доступа к ${noun}. Разрешите его в настройках системы.`
    case 'NotFoundError':
    case 'OverconstrainedError':
      return what === 'экран' ? 'Выбранный экран или окно больше недоступны.' : `Устройство (${what}) не найдено. Проверьте подключение или выберите другое в настройках.`
    case 'NotReadableError':
    case 'AbortError':
      return `Устройство (${what}) занято другой программой или недоступно.`
    default:
      return `Ошибка (${what}): ${e?.message ?? String(err)}`
  }
}

export class VoiceEngine {
  private device: Device | null = null
  private sendT: types.Transport | null = null
  private recvT: types.Transport | null = null
  private mic: types.Producer | null = null
  private micStream: MediaStream | null = null
  private denoise: DenoisedTrack | null = null
  private remotes = new Map<string, RemoteAudio>()
  private videos = new Map<string, RemoteVideo>()
  private pending: ProducerInfo[] = []
  private ready = false
  /** Растёт при каждом входе/выходе: устаревшие асинхронные шаги прекращаются. */
  private gen = 0
  private iceTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private iceRestarts = new Map<string, number>()
  private pttReleaseTimer: ReturnType<typeof setTimeout> | null = null
  private pageVisible = typeof document === 'undefined' || document.visibilityState === 'visible'

  /* Локальные камера и экран переживают переподключение: после перезахода публикуются снова. */
  private cameraTrack: MediaStreamTrack | null = null
  private cameraProducer: types.Producer | null = null
  private screenTrack: MediaStreamTrack | null = null
  private screenAudioTrack: MediaStreamTrack | null = null
  private screenProducer: types.Producer | null = null
  private screenAudioProducer: types.Producer | null = null
  private screenOptions: ScreenShareOptions | null = null

  channelId: string | null = null
  private muted = false
  private deafened = false
  private pttActive = false

  constructor(
    private request: Requester,
    private hooks: EngineHooks,
    private settings: () => VoiceSettings
  ) {}

  get inChannel(): boolean {
    return this.channelId !== null
  }

  /* ======================= вход и выход ======================= */

  async join(channelId: string): Promise<void> {
    this.closeLocal(true)
    const gen = ++this.gen
    this.channelId = channelId
    this.hooks.onStatus('connecting', null)
    const stale = (): boolean => gen !== this.gen

    try {
      const { routerRtpCapabilities } = await this.request('voice-join', { channelId })
      if (stale()) return
      const device = new Device()
      await device.load({ routerRtpCapabilities: routerRtpCapabilities as unknown as types.RtpCapabilities })
      if (stale()) return
      this.device = device

      this.sendT = await this.createTransport('send', gen)
      this.recvT = await this.createTransport('recv', gen)
      if (stale()) return

      const { producers } = await this.request('voice-ready', { rtpCapabilities: device.rtpCapabilities as unknown as MediaJson })
      if (stale()) return
      this.ready = true

      await this.startMic(gen)
      if (stale()) return
      // После переподключения снова публикуем камеру и экран, если они были включены.
      await this.republishLocal(gen)
      if (stale()) return

      const all = [...producers, ...this.pending]
      this.pending = []
      for (const p of all) void this.consume(p)
      this.hooks.onStatus('connected', null)
    } catch (err) {
      if (stale()) return
      console.error('[voice] не удалось войти в канал', err)
      this.closeLocal(true)
      this.channelId = channelId
      this.hooks.onStatus('error', (err as Error).message || 'Не удалось подключиться к голосу')
      throw err
    }
  }

  /** Выход из канала с уведомлением сервера. */
  async leave(): Promise<void> {
    const was = this.channelId
    this.closeLocal(false)
    this.channelId = null
    this.hooks.onStatus('idle', null)
    if (was) {
      try {
        await this.request('voice-leave', {})
      } catch {
        /* соединения может не быть — сервер сам уберёт нас из канала */
      }
    }
  }

  /**
   * Закрывает всё локально, не трогая сервер.
   * keepLocal — не выключать камеру и демонстрацию (они вернутся после перезахода).
   */
  closeLocal(keepLocal = false): void {
    this.gen++
    this.ready = false
    this.pending = []
    for (const t of this.iceTimers.values()) clearTimeout(t)
    this.iceTimers.clear()
    this.iceRestarts.clear()
    for (const r of this.remotes.values()) this.disposeRemote(r)
    this.remotes.clear()
    for (const v of this.videos.values()) this.safeClose(v.consumer)
    this.videos.clear()
    this.emitVideos()
    this.safeClose(this.mic)
    this.mic = null
    this.stopMicStream()
    this.safeClose(this.cameraProducer)
    this.safeClose(this.screenProducer)
    this.safeClose(this.screenAudioProducer)
    this.cameraProducer = null
    this.screenProducer = null
    this.screenAudioProducer = null
    if (!keepLocal) {
      this.stopCameraTrack()
      this.stopScreenTracks()
    }
    try {
      this.sendT?.close()
      this.recvT?.close()
    } catch {
      /* ignore */
    }
    this.sendT = null
    this.recvT = null
    this.device = null
  }

  private safeClose(x: { close(): void; closed?: boolean } | null): void {
    try {
      if (x && !x.closed) x.close()
    } catch {
      /* ignore */
    }
  }

  /* ======================= транспорты ======================= */

  private async createTransport(direction: 'send' | 'recv', gen: number): Promise<types.Transport> {
    const info = await this.request('transport-create', { direction })
    if (!this.device || gen !== this.gen) throw new Error('Вход в канал прерван')
    const options = {
      id: info.id,
      iceParameters: info.iceParameters as unknown as types.IceParameters,
      iceCandidates: info.iceCandidates as unknown as types.IceCandidate[],
      dtlsParameters: info.dtlsParameters as unknown as types.DtlsParameters,
      iceServers: [],
      iceTransportPolicy: 'all' as const
    }
    const t = direction === 'send' ? this.device.createSendTransport(options) : this.device.createRecvTransport(options)

    t.on('connect', ({ dtlsParameters }, callback, errback) => {
      this.request('transport-connect', { transportId: t.id, dtlsParameters: dtlsParameters as unknown as MediaJson })
        .then(() => callback())
        .catch((err: Error) => errback(err))
    })

    if (direction === 'send') {
      t.on('produce', ({ kind, rtpParameters, appData }, callback, errback) => {
        const s = appData.source
        const source: MediaSource = s === 'camera' || s === 'screen' || s === 'screen-audio' ? s : 'mic'
        this.request('produce', {
          transportId: t.id,
          kind,
          rtpParameters: rtpParameters as unknown as MediaJson,
          source,
          paused: appData.paused === true
        })
          .then(({ producerId }) => callback({ id: producerId }))
          .catch((err: Error) => errback(err))
      })
    }

    t.on('connectionstatechange', (state) => this.onTransportState(t, state, gen))
    return t
  }

  private onTransportState(t: types.Transport, state: string, gen: number): void {
    if (gen !== this.gen) return
    const existing = this.iceTimers.get(t.id)
    if (existing) {
      clearTimeout(existing)
      this.iceTimers.delete(t.id)
    }
    if (state === 'connected') {
      this.iceRestarts.set(t.id, 0)
      if (this.ready) this.hooks.onStatus('connected', null)
      return
    }
    if (state === 'disconnected' || state === 'failed') {
      this.hooks.onStatus('reconnecting', null)
      const delay = state === 'failed' ? 0 : ICE_RESTART_DELAY_MS
      this.iceTimers.set(
        t.id,
        setTimeout(() => void this.restartIce(t, gen), delay)
      )
    }
  }

  private async restartIce(t: types.Transport, gen: number): Promise<void> {
    if (gen !== this.gen || t.closed) return
    const attempts = (this.iceRestarts.get(t.id) ?? 0) + 1
    this.iceRestarts.set(t.id, attempts)
    if (attempts > MAX_ICE_RESTARTS) {
      console.warn('[voice] ICE не восстановился, перезаходим в канал')
      this.hooks.onFatalTransport()
      return
    }
    try {
      const { iceParameters } = await this.request('transport-restart-ice', { transportId: t.id })
      if (gen !== this.gen || t.closed) return
      await t.restartIce({ iceParameters: iceParameters as unknown as types.IceParameters })
      console.info(`[voice] ICE restart #${attempts} для ${t.direction}`)
      this.iceTimers.set(
        t.id,
        setTimeout(() => {
          if (t.connectionState !== 'connected') void this.restartIce(t, gen)
        }, 5_000)
      )
    } catch (err) {
      console.warn('[voice] ICE restart не удался', err)
      if (gen === this.gen) this.hooks.onFatalTransport()
    }
  }

  /* ======================= микрофон ======================= */

  /** builtinNoise — включить встроенное в браузер шумоподавление. */
  private audioConstraints(builtinNoise: boolean): MediaTrackConstraints {
    const s = this.settings()
    return {
      deviceId: s.inputDeviceId ? { exact: s.inputDeviceId } : undefined,
      echoCancellation: s.echoCancellation,
      noiseSuppression: builtinNoise,
      autoGainControl: s.autoGainControl,
      channelCount: 1,
      sampleRate: 48000
    }
  }

  /**
   * Открывает микрофон и, если выбрано усиленное шумоподавление, пропускает его через нейросеть.
   * Старый микрофон отпускается только после открытия нового: пока страница что-то записывает,
   * Safari разрешает и новый запрос микрофона, и запуск звука без нажатия пользователя.
   */
  private async openMic(): Promise<MediaStreamTrack> {
    const allowed = await window.zvon.ensureMediaAccess('microphone')
    if (!allowed) throw Object.assign(new Error('Нет доступа к микрофону'), { name: 'NotAllowedError' })
    const ai = effectiveNoiseMode(this.settings()) === 'ai'
    // С нейросетью встроенное шумоподавление выключаем, чтобы звук не обрабатывался дважды.
    const constraints = this.audioConstraints(effectiveNoiseMode(this.settings()) === 'standard')
    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: constraints, video: false })
    } catch (err) {
      // Выбранное устройство пропало — пробуем микрофон по умолчанию.
      const name = (err as DOMException).name
      if ((name === 'OverconstrainedError' || name === 'NotFoundError') && this.settings().inputDeviceId) {
        stream = await navigator.mediaDevices.getUserMedia({ audio: { ...constraints, deviceId: undefined }, video: false })
      } else {
        throw err
      }
    }
    this.stopMicStream()
    this.micStream = stream
    const track = stream.getAudioTracks()[0]
    if (!track) throw new Error('Микрофон не выдал аудиодорожку')
    this.watchMic(track)
    this.micOpenedAt = Date.now()
    const info = track.getSettings()
    diag(`микрофон открыт: ${info.sampleRate ?? '?'} Гц, шумоподавление «${effectiveNoiseMode(this.settings())}»`)
    if (!ai) return track
    try {
      const denoise = await createDenoisedTrack(track, {
        onFallback: (reason) => {
          diag(`нейросеть шумоподавления отключилась: ${reason}`)
          if (this.denoise === denoise) this.hooks.onMicError(DENOISE_NOTICE[reason])
        }
      })
      this.denoise = denoise
      // Обработанная дорожка сама не узнаёт, что микрофон отключили, — следим за исходной.
      track.addEventListener('ended', () => {
        if (this.denoise === denoise) void this.restartMic('auto')
      })
      diag(denoise.engine === 'dfn' ? 'шумоподавление: нейросеть DeepFilterNet работает' : 'шумоподавление: нейросеть не загрузилась, упрощённый режим (RNNoise)')
      if (denoise.engine !== 'dfn') this.micNotice = DENOISE_NOTICE.load
      return denoise.track
    } catch (err) {
      console.warn('[voice] усиленное шумоподавление недоступно, используется встроенное', err)
      diag(`шумоподавление: усиленное не запустилось (${errText(err)}), работает встроенное`)
      this.micNotice = `Усиленное шумоподавление не запустилось (${(err as Error).message}) — работает обычное`
      await track.applyConstraints(this.audioConstraints(true)).catch(() => undefined)
      return track
    }
  }

  /** Предупреждение, которое покажется после успешного запуска микрофона. */
  private micNotice: string | null = null

  /** Система приглушила микрофон (track.muted): телефон отдал звук другому приложению или видео. */
  private watchMic(track: MediaStreamTrack): void {
    const report = (): void => {
      if (this.micStream?.getAudioTracks()[0] !== track) return
      diag(track.muted ? 'микрофон приглушён системой' : 'микрофон снова работает')
      this.hooks.onMicInterrupted(track.muted)
    }
    track.addEventListener('ended', () => {
      if (this.micStream?.getAudioTracks()[0] === track) diag('микрофон остановлен системой')
    })
    track.addEventListener('mute', report)
    track.addEventListener('unmute', report)
  }

  /** Когда открыт текущий микрофон: трек, умерший сразу после открытия, — признак того, что система его не отдаёт. */
  private micOpenedAt = 0
  /** Сколько раз подряд микрофон погас, не прожив и трёх секунд. */
  private micQuickFailures = 0

  /** Микрофон открыт, но система его приглушила или остановила. */
  get micInterrupted(): boolean {
    return this.micStream?.getAudioTracks().some((t) => t.readyState === 'ended' || t.muted) ?? false
  }

  private stopMicStream(): void {
    this.denoise?.stop()
    this.denoise = null
    this.micStream?.getTracks().forEach((t) => t.stop())
    this.micStream = null
  }

  private async startMic(gen: number): Promise<void> {
    if (!this.sendT || !this.device?.canProduce('audio')) {
      this.hooks.onMicError('Это устройство не может передавать звук')
      return
    }
    try {
      const track = await this.openMic()
      if (gen !== this.gen) {
        track.stop()
        return
      }
      const transmit = this.shouldTransmit()
      if (!transmit) track.enabled = false
      this.mic = await this.sendT.produce({
        track,
        stopTracks: false,
        codecOptions: {
          opusStereo: false,
          opusDtx: true,
          opusFec: true,
          opusMaxAverageBitrate: BITRATE.opusMaxAverage
        },
        appData: { source: 'mic', paused: !transmit }
      })
      if (!transmit) this.mic.pause()
      this.mic.on('trackended', () => {
        console.warn('[voice] микрофон отключён, пробую переоткрыть')
        void this.restartMic('auto')
      })
      this.hooks.onMicError(this.micNotice)
      this.micNotice = null
    } catch (err) {
      console.error('[voice] микрофон', err)
      diag(`микрофон не открылся: ${errText(err)}`)
      this.hooks.onMicError(mediaErrorText(err, 'микрофон'))
    }
  }

  /** Очередь переоткрытий: два одновременных открытия микрофона мешают друг другу. */
  private micQueue: Promise<void> = Promise.resolve()

  /**
   * Переоткрывает микрофон (смена устройства или обработки звука, восстановление после сбоя).
   * reason 'auto' — само приложение заметило, что микрофон погас: после трёх быстрых неудач подряд
   * такие попытки прекращаются, пока человек не нажмёт на экран или не сменит настройку ('user'),
   * иначе телефон, у которого микрофон занят, дёргался бы каждую секунду.
   */
  restartMic(reason: 'auto' | 'user' = 'user'): Promise<void> {
    if (reason === 'user') this.micQuickFailures = 0
    // Переоткрытие уже ждёт своей очереди — второе подряд не нужно (один сбой приходит двумя событиями).
    if (this.micRestartQueued) return this.micQueue
    if (reason === 'auto') {
      if (this.micOpenedAt && Date.now() - this.micOpenedAt < 3000) {
        if (++this.micQuickFailures === 3) diag('микрофон гаснет сразу после открытия — больше не пробую сам, жду нажатия')
        if (this.micQuickFailures >= 3) return this.micQueue
      } else this.micQuickFailures = 0
    }
    this.micRestartQueued = true
    this.micQueue = this.micQueue.then(() => {
      this.micRestartQueued = false
      return this.doRestartMic()
    })
    return this.micQueue
  }

  private micRestartQueued = false

  private async doRestartMic(attempt = 0): Promise<void> {
    if (!this.inChannel || !this.ready) return
    const gen = this.gen
    if (!this.mic) {
      await this.startMic(gen)
      return
    }
    try {
      const track = await this.openMic()
      if (gen !== this.gen || !this.mic) {
        track.stop()
        return
      }
      if (track.readyState === 'ended') throw Object.assign(new Error('track ended'), { name: 'InvalidStateError' })
      track.enabled = this.shouldTransmit()
      await this.mic.replaceTrack({ track })
      this.hooks.onMicError(this.micNotice)
      this.micNotice = null
    } catch (err) {
      diag(`микрофон не переоткрылся: ${errText(err)}`)
      if (gen !== this.gen) return
      // Микрофон открылся и тут же остановился: система ещё не отдала его. Пробуем ещё пару раз, не чаще раза в секунду.
      if ((err as DOMException).name === 'InvalidStateError' && attempt < 2 && this.micQuickFailures < 3) {
        this.micQuickFailures++
        await new Promise((resolve) => setTimeout(resolve, 1000))
        if (gen === this.gen) await this.doRestartMic(attempt + 1)
        return
      }
      this.hooks.onMicError(mediaErrorText(err, 'микрофон'))
    }
  }

  private shouldTransmit(): boolean {
    if (this.muted || this.deafened) return false
    return this.settings().mode === 'voice' || this.pttActive
  }

  /** Синхронизирует паузу микрофона с mute/deafen/PTT. Пауза экономит канал хоста. */
  private applyTransmit(): void {
    const mic = this.mic
    if (!mic || mic.closed) return
    const transmit = this.shouldTransmit()
    if (transmit && mic.paused) {
      mic.resume()
      this.request('producer-resume', { producerId: mic.id }).catch((err) => console.warn('[voice] producer-resume', err))
    } else if (!transmit && !mic.paused) {
      mic.pause()
      this.request('producer-pause', { producerId: mic.id }).catch((err) => console.warn('[voice] producer-pause', err))
    }
  }

  setMuted(muted: boolean): void {
    this.muted = muted
    this.applyTransmit()
  }

  setDeafened(deafened: boolean): void {
    if (this.deafened === deafened) return
    this.deafened = deafened
    for (const r of this.remotes.values()) {
      this.applyVolume(r)
      this.syncAudio(r)
    }
    this.applyTransmit()
  }

  /** PTT: при отпускании держим микрофон открытым ещё pttReleaseMs. */
  setPtt(active: boolean): void {
    if (this.pttReleaseTimer) {
      clearTimeout(this.pttReleaseTimer)
      this.pttReleaseTimer = null
    }
    if (active) {
      this.pttActive = true
      this.applyTransmit()
    } else {
      this.pttReleaseTimer = setTimeout(() => {
        this.pttActive = false
        this.applyTransmit()
      }, this.settings().pttReleaseMs)
    }
  }

  /** Режим (голос/PTT) мог смениться в настройках. */
  refreshTransmit(): void {
    this.applyTransmit()
  }

  /* ======================= камера ======================= */

  private emitLocal(): void {
    this.hooks.onLocalMedia({ camera: this.cameraTrack, screen: this.screenTrack, screenHasAudio: this.screenAudioTrack !== null })
  }

  private vp8(): types.RtpCodecCapability | undefined {
    return this.device?.rtpCapabilities.codecs?.find((c) => c.mimeType.toLowerCase() === 'video/vp8')
  }

  private vp9(): types.RtpCodecCapability | undefined {
    return this.device?.rtpCapabilities.codecs?.find((c) => c.mimeType.toLowerCase() === 'video/vp9')
  }

  async startCamera(): Promise<void> {
    if (!this.ready || !this.sendT) throw new Error('Сначала войдите в голосовой канал')
    if (this.cameraTrack) return
    if (!(await window.zvon.ensureMediaAccess('camera'))) throw new Error(mediaErrorText({ name: 'NotAllowedError' }, 'камера'))
    const deviceId = this.settings().videoInputDeviceId
    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          deviceId: deviceId ? { exact: deviceId } : undefined,
          width: { ideal: 1280 },
          height: { ideal: 720 },
          frameRate: { ideal: 30, max: 30 }
        }
      })
    } catch (err) {
      throw new Error(mediaErrorText(err, 'камера'))
    }
    const track = stream.getVideoTracks()[0]
    if (!track) throw new Error('Камера не выдала видеодорожку')
    track.contentHint = 'motion'
    track.addEventListener('ended', () => void this.stopCamera())
    this.cameraTrack = track
    this.emitLocal()
    try {
      await this.produceCamera(this.gen)
    } catch (err) {
      this.stopCameraTrack()
      this.emitLocal()
      throw err
    }
  }

  private async produceCamera(gen: number): Promise<void> {
    if (!this.sendT || !this.cameraTrack || gen !== this.gen) return
    this.cameraProducer = await this.sendT.produce({
      track: this.cameraTrack,
      stopTracks: false,
      encodings: CAMERA_ENCODINGS.map((e) => ({ ...e })),
      codec: this.vp8(),
      codecOptions: { videoGoogleStartBitrate: 1000 },
      appData: { source: 'camera' }
    })
  }

  async stopCamera(): Promise<void> {
    const producer = this.cameraProducer
    this.cameraProducer = null
    this.stopCameraTrack()
    this.emitLocal()
    if (producer && !producer.closed) {
      producer.close()
      await this.request('producer-close', { producerId: producer.id }).catch(() => undefined)
    }
  }

  private stopCameraTrack(): void {
    this.cameraTrack?.stop()
    this.cameraTrack = null
  }

  /* ======================= демонстрация экрана ======================= */

  async startScreen(opts: ScreenShareOptions): Promise<{ audioWarning: string | null }> {
    if (!this.ready || !this.sendT) throw new Error('Сначала войдите в голосовой канал')
    if (this.screenTrack) await this.stopScreen()
    const preset = SCREEN_PRESETS[opts.quality]
    let audioWarning: string | null = null

    await window.zvon.screenSelect(opts.sourceId, opts.loopbackAudio)
    const video: MediaTrackConstraints = {
      width: { ideal: preset.width, max: preset.width },
      height: { ideal: preset.height, max: preset.height },
      frameRate: { ideal: preset.fps, max: preset.fps }
    }
    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({ video, audio: opts.loopbackAudio })
    } catch (err) {
      if (!opts.loopbackAudio) throw new Error(mediaErrorText(err, 'экран'))
      // Звук системы не дали — показываем экран без звука.
      console.warn('[voice] демонстрация со звуком не удалась, пробую без звука', err)
      audioWarning = 'Звук системы захватить не удалось — демонстрация идёт без звука.'
      await window.zvon.screenSelect(opts.sourceId, false)
      try {
        stream = await navigator.mediaDevices.getDisplayMedia({ video, audio: false })
      } catch (err2) {
        throw new Error(mediaErrorText(err2, 'экран'))
      }
    }

    const track = stream.getVideoTracks()[0]
    if (!track) throw new Error('Захват экрана не выдал видеодорожку')
    track.contentHint = opts.content === 'motion' ? 'motion' : 'detail'
    await track.applyConstraints(video).catch(() => undefined)

    let audioTrack: MediaStreamTrack | null = stream.getAudioTracks()[0] ?? null
    if (opts.loopbackAudio && !audioTrack && !audioWarning) audioWarning = 'Система не отдала звук — демонстрация идёт без звука.'
    if (!audioTrack && opts.monitorDeviceId) {
      try {
        const monitor = await navigator.mediaDevices.getUserMedia({
          audio: {
            deviceId: { exact: opts.monitorDeviceId },
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
            channelCount: 2
          }
        })
        audioTrack = monitor.getAudioTracks()[0] ?? null
      } catch (err) {
        console.warn('[voice] monitor-устройство недоступно', err)
        audioWarning = 'Не удалось открыть звук системы (Monitor) — демонстрация идёт без звука.'
      }
    }

    this.screenTrack = track
    this.screenAudioTrack = audioTrack
    this.screenOptions = opts
    track.addEventListener('ended', () => void this.stopScreen())
    this.emitLocal()
    try {
      await this.produceScreen(this.gen)
    } catch (err) {
      this.stopScreenTracks()
      this.emitLocal()
      throw err
    }
    return { audioWarning }
  }

  private async produceScreen(gen: number): Promise<void> {
    if (!this.sendT || !this.screenTrack || !this.screenOptions || gen !== this.gen) return
    const preset = SCREEN_PRESETS[this.screenOptions.quality]
    const vp9 = this.vp9()
    const common = { track: this.screenTrack, stopTracks: false, codecOptions: { videoGoogleStartBitrate: 1000 }, appData: { source: 'screen' } }
    let producer: types.Producer | null = null
    if (vp9) {
      // VP9 SVC: один поток с тремя пространственными слоями — SFU отдаёт каждому зрителю свой.
      try {
        producer = await this.sendT.produce({
          ...common,
          codec: vp9,
          encodings: [{ scalabilityMode: 'L3T3_KEY', maxBitrate: preset.bitrate }]
        })
      } catch (err) {
        console.warn('[voice] VP9 SVC недоступен, переключаюсь на VP8 simulcast', err)
      }
    }
    if (!producer) {
      producer = await this.sendT.produce({
        ...common,
        codec: this.vp8(),
        encodings: [
          { scaleResolutionDownBy: 2, maxBitrate: Math.round(preset.bitrate * 0.3), scalabilityMode: 'L1T3' },
          { scaleResolutionDownBy: 1, maxBitrate: preset.bitrate, scalabilityMode: 'L1T3' }
        ]
      })
    }
    if (gen !== this.gen) {
      producer.close()
      return
    }
    this.screenProducer = producer
    if (this.screenAudioTrack) {
      this.screenAudioProducer = await this.sendT.produce({
        track: this.screenAudioTrack,
        stopTracks: false,
        codecOptions: { opusStereo: true, opusDtx: false, opusFec: true, opusMaxAverageBitrate: 128_000 },
        appData: { source: 'screen-audio' }
      })
    }
  }

  async stopScreen(): Promise<void> {
    const producers = [this.screenProducer, this.screenAudioProducer]
    this.screenProducer = null
    this.screenAudioProducer = null
    this.stopScreenTracks()
    this.emitLocal()
    for (const p of producers) {
      if (p && !p.closed) {
        p.close()
        await this.request('producer-close', { producerId: p.id }).catch(() => undefined)
      }
    }
  }

  private stopScreenTracks(): void {
    this.screenTrack?.stop()
    this.screenAudioTrack?.stop()
    this.screenTrack = null
    this.screenAudioTrack = null
    this.screenOptions = null
  }

  private async republishLocal(gen: number): Promise<void> {
    try {
      if (this.cameraTrack?.readyState === 'live') await this.produceCamera(gen)
      else this.stopCameraTrack()
      if (this.screenTrack?.readyState === 'live') await this.produceScreen(gen)
      else this.stopScreenTracks()
    } catch (err) {
      console.warn('[voice] не удалось восстановить камеру или демонстрацию', err)
      this.stopCameraTrack()
      this.stopScreenTracks()
    }
    this.emitLocal()
  }

  /* ======================= приём ======================= */

  async consume(p: ProducerInfo): Promise<void> {
    if (!this.ready || !this.recvT || !this.device) {
      this.pending.push(p)
      return
    }
    const gen = this.gen
    try {
      const info = await this.request('consume', { producerId: p.producerId })
      if (gen !== this.gen || !this.recvT) return
      const consumer = await this.recvT.consume({
        id: info.consumerId,
        producerId: info.producerId,
        kind: info.kind,
        rtpParameters: info.rtpParameters as unknown as types.RtpParameters,
        appData: { userId: info.userId, source: info.source }
      })
      if (gen !== this.gen) {
        consumer.close()
        return
      }
      if (info.kind === 'video') this.addVideo(consumer, info)
      else await this.addAudio(consumer, info)
    } catch (err) {
      console.warn('[voice] не удалось принять поток', p.producerId, err)
    }
  }

  private async addAudio(consumer: types.Consumer, info: ConsumerInfo): Promise<void> {
    const el = new Audio() as SinkableAudio
    el.autoplay = true
    el.setAttribute('playsinline', '')
    el.srcObject = new MediaStream([consumer.track])
    const sink = this.settings().outputDeviceId
    if (sink && el.setSinkId) el.setSinkId(sink).catch((err) => console.warn('[voice] setSinkId', err))
    this.play(el)

    const remote: RemoteAudio = { consumer, userId: info.userId, source: info.source, el, playing: false, boost: null }
    this.remotes.set(consumer.id, remote)
    this.applyVolume(remote)
    consumer.on('trackended', () => this.removeRemote(consumer.id))
    consumer.on('transportclose', () => this.removeRemote(consumer.id))
    this.syncAudio(remote)
    if (info.source === 'screen-audio') this.emitVideos()
  }

  /** Нужен ли звук: не оглохли, а звук демонстрации — только пока смотрим её. */
  private audioWanted(r: RemoteAudio): boolean {
    if (this.deafened) return false
    if (r.source !== 'screen-audio') return true
    for (const v of this.videos.values()) if (v.info.userId === r.userId && v.info.source === 'screen' && v.active) return true
    return false
  }

  private syncAudio(r: RemoteAudio): void {
    const want = this.audioWanted(r)
    if (want === r.playing) return
    r.playing = want
    if (want) {
      r.consumer.resume()
      this.request('consumer-resume', { consumerId: r.consumer.id }).catch(() => undefined)
    } else {
      r.consumer.pause()
      this.request('consumer-pause', { consumerId: r.consumer.id }).catch(() => undefined)
    }
  }

  private addVideo(consumer: types.Consumer, info: ConsumerInfo): void {
    // Видео создаётся на паузе и включается, только когда его кто-то смотрит.
    const v: RemoteVideo = { consumer, info, wants: new Map(), manualLayer: null, active: false, appliedLayer: null, currentSpatial: null }
    this.videos.set(consumer.id, v)
    consumer.on('trackended', () => this.removeVideo(consumer.id))
    consumer.on('transportclose', () => this.removeVideo(consumer.id))
    this.emitVideos()
  }

  private removeVideo(consumerId: string): void {
    const v = this.videos.get(consumerId)
    if (!v) return
    this.videos.delete(consumerId)
    this.safeClose(v.consumer)
    this.syncScreenAudio(v.info.userId)
    this.emitVideos()
  }

  private syncScreenAudio(userId: string): void {
    for (const r of this.remotes.values()) if (r.userId === userId && r.source === 'screen-audio') this.syncAudio(r)
  }

  /** Зритель (плитка или окно просмотра) хочет видеть поток с указанным слоем; null — больше не смотрит. */
  wantVideo(consumerId: string, viewer: string, layer: number | null): void {
    const v = this.videos.get(consumerId)
    if (!v) return
    if (layer === null) v.wants.delete(viewer)
    else v.wants.set(viewer, layer)
    this.reconcile(v)
  }

  setManualLayer(consumerId: string, layer: number | null): void {
    const v = this.videos.get(consumerId)
    if (!v) return
    v.manualLayer = layer
    this.reconcile(v)
  }

  /**
   * Возобновляет звук собеседников, если браузер поставил его на паузу.
   * Мобильные браузеры отдают звук видео из чата и сами звонок не возвращают.
   */
  resumePlayback(): void {
    for (const r of this.remotes.values()) {
      if (r.el.paused) this.play(r.el)
    }
    if (this.boostCtx && this.boostCtx.state !== 'running' && this.boostCtx.state !== 'closed') void this.boostCtx.resume().catch(() => undefined)
  }

  /**
   * Восстановление звука звонка без перезахода в канал: пересоздаёт элементы воспроизведения,
   * будит Web Audio и переоткрывает микрофон, если система его приглушила или остановила
   * (так делает iPhone, когда звук забирает видео, Siri или обычный звонок).
   * Лучше всего срабатывает прямо в обработчике нажатия: Safari охотнее запускает звук по действию пользователя.
   */
  async recoverAudio(): Promise<void> {
    if (!this.inChannel || !this.ready) return
    const gen = this.gen
    diag(`восстанавливаю звук звонка (собеседников: ${this.remotes.size}, микрофон ${this.micInterrupted ? 'приглушён' : 'в порядке'})`)
    await this.rebuildPlayback()
    if (!this.micInterrupted) return
    await this.restartMic()
    // При перезаходе звук собеседников подключается после микрофона — повторяем тот же порядок.
    if (gen === this.gen && this.ready) await this.rebuildPlayback()
  }

  /** Поставить звук собеседников на паузу (звонок уступает звук видео из чата). */
  pausePlayback(): void {
    for (const r of this.remotes.values()) {
      try {
        r.el.pause()
      } catch {
        /* ignore */
      }
    }
  }

  private play(el: HTMLAudioElement): void {
    el.play().catch((err) => {
      console.warn('[voice] воспроизведение не началось', err)
      diag(`звук собеседника не запустился: ${errText(err)}`)
    })
  }

  /** Пересоздаёт элементы воспроизведения собеседников и будит Web Audio. */
  private async rebuildPlayback(): Promise<void> {
    for (const r of this.remotes.values()) {
      if (r.consumer.closed) continue
      this.dropBoost(r)
      // Элемент остаётся тот же (новые копились бы в браузере), но поток подключается заново —
      // это заставляет браузер заново собрать вывод звука.
      try {
        r.el.pause()
        r.el.srcObject = new MediaStream([r.consumer.track])
      } catch {
        /* ignore */
      }
      this.applyVolume(r)
      this.play(r.el)
    }
    if (this.boostCtx && this.boostCtx.state !== 'running' && this.boostCtx.state !== 'closed') {
      await this.boostCtx.resume().catch(() => undefined)
    }
  }

  /** Есть ли звук собеседников на паузе (нужно вернуть). */
  get playbackStalled(): boolean {
    for (const r of this.remotes.values()) {
      if (r.el.paused) return true
      if (r.boost && this.boostCtx?.state !== 'running') return true
    }
    return false
  }

  /** Окно свёрнуто или скрыто — видео ставится на паузу (кроме отдельных окон просмотра). */
  setPageVisible(visible: boolean): void {
    if (this.pageVisible === visible) return
    this.pageVisible = visible
    for (const v of this.videos.values()) this.reconcile(v)
  }

  private reconcile(v: RemoteVideo): void {
    const visible = [...v.wants.entries()].filter(([key]) => this.pageVisible || key.startsWith(POPOUT_KEY))
    const shouldBeActive = visible.length > 0
    let changed = false

    if (shouldBeActive && v.info.spatialLayers > 1) {
      const wanted = v.manualLayer ?? Math.max(...visible.map(([, layer]) => layer))
      const layer = Math.max(0, Math.min(v.info.spatialLayers - 1, wanted))
      if (layer !== v.appliedLayer) {
        v.appliedLayer = layer
        this.request('consumer-set-layers', { consumerId: v.consumer.id, spatialLayer: layer }).catch((err) =>
          console.warn('[voice] consumer-set-layers', err)
        )
        changed = true
      }
    }
    if (shouldBeActive !== v.active) {
      v.active = shouldBeActive
      changed = true
      if (shouldBeActive) {
        v.consumer.resume()
        this.request('consumer-resume', { consumerId: v.consumer.id }).catch(() => undefined)
      } else {
        v.consumer.pause()
        v.currentSpatial = null
        this.request('consumer-pause', { consumerId: v.consumer.id }).catch(() => undefined)
      }
      if (v.info.source === 'screen') this.syncScreenAudio(v.info.userId)
    }
    if (changed) this.emitVideos()
  }

  onConsumerLayers(consumerId: string, spatialLayer: number | null): void {
    const v = this.videos.get(consumerId)
    if (!v) return
    v.currentSpatial = spatialLayer
    this.emitVideos()
  }

  private emitVideos(): void {
    const list: RemoteVideoView[] = []
    for (const v of this.videos.values()) {
      const source = v.info.source === 'screen' ? 'screen' : 'camera'
      list.push({
        consumerId: v.consumer.id,
        producerId: v.info.producerId,
        userId: v.info.userId,
        source,
        track: v.consumer.track,
        spatialLayers: v.info.spatialLayers,
        currentSpatial: v.currentSpatial,
        manualLayer: v.manualLayer,
        active: v.active,
        hasAudio:
          source === 'screen' && [...this.remotes.values()].some((r) => r.userId === v.info.userId && r.source === 'screen-audio')
      })
    }
    this.hooks.onVideos(list)
  }

  private disposeRemote(r: RemoteAudio): void {
    this.dropBoost(r)
    try {
      r.el.pause()
      r.el.srcObject = null
      r.consumer.close()
    } catch {
      /* ignore */
    }
  }

  private removeRemote(consumerId: string): void {
    const r = this.remotes.get(consumerId)
    if (!r) return
    this.remotes.delete(consumerId)
    this.disposeRemote(r)
    if (r.source === 'screen-audio') this.emitVideos()
  }

  onProducerClosed(producerId: string): void {
    this.pending = this.pending.filter((p) => p.producerId !== producerId)
    for (const [id, r] of this.remotes) if (r.consumer.producerId === producerId) this.removeRemote(id)
    for (const [id, v] of this.videos) if (v.info.producerId === producerId) this.removeVideo(id)
  }

  onConsumerClosed(consumerId: string): void {
    this.removeRemote(consumerId)
    this.removeVideo(consumerId)
  }

  /* ======================= громкость и вывод ======================= */

  /** Громкость потока: голос — по участнику, звук демонстрации — отдельно (0…MAX_VOLUME). */
  private volumeOf(r: RemoteAudio): number {
    const s = this.settings()
    const v = r.source === 'screen-audio' ? s.streamVolumes[r.userId] : s.userVolumes[r.userId]
    return typeof v === 'number' && Number.isFinite(v) ? Math.min(MAX_VOLUME, Math.max(0, v)) : 1
  }

  /**
   * До 100% громкость задаёт сам элемент. Выше — HTMLMediaElement не умеет, поэтому звук идёт
   * через GainNode, а элемент продолжает играть беззвучно: без этого Chrome не отдаёт удалённый звук в Web Audio.
   */
  private applyVolume(r: RemoteAudio): void {
    const v = this.volumeOf(r)
    if (v <= 1) {
      this.dropBoost(r)
      r.el.volume = v
      r.el.muted = this.deafened
      return
    }
    r.el.volume = 1
    r.el.muted = true
    if (!r.boost) {
      const ctx = this.boostContext()
      if (!ctx) {
        // Web Audio недоступен — играем на максимуме элемента.
        r.el.muted = this.deafened
        return
      }
      const source = ctx.createMediaStreamSource(new MediaStream([r.consumer.track]))
      const gain = ctx.createGain()
      source.connect(gain).connect(ctx.destination)
      r.boost = { source, gain }
    }
    r.boost.gain.gain.value = this.deafened ? 0 : v
  }

  private dropBoost(r: RemoteAudio): void {
    if (!r.boost) return
    try {
      r.boost.source.disconnect()
      r.boost.gain.disconnect()
    } catch {
      /* уже отключено */
    }
    r.boost = null
  }

  private boostCtx: SinkableContext | null = null

  private boostContext(): SinkableContext | null {
    try {
      if (!this.boostCtx || this.boostCtx.state === 'closed') {
        this.boostCtx = new AudioContext() as SinkableContext
        const sink = this.settings().outputDeviceId
        if (sink && this.boostCtx.setSinkId) this.boostCtx.setSinkId(sink).catch((err) => console.warn('[voice] setSinkId', err))
      }
      if (this.boostCtx.state !== 'running') void this.boostCtx.resume().catch(() => undefined)
      return this.boostCtx
    } catch (err) {
      console.warn('[voice] Web Audio недоступен', err)
      return null
    }
  }

  /** Применить громкости из настроек ко всем принимаемым потокам. */
  refreshVolumes(): void {
    for (const r of this.remotes.values()) this.applyVolume(r)
  }

  async setOutputDevice(deviceId: string): Promise<void> {
    for (const r of this.remotes.values()) {
      const el = r.el as SinkableAudio
      if (el.setSinkId) await el.setSinkId(deviceId).catch((err) => console.warn('[voice] setSinkId', err))
    }
    if (this.boostCtx?.setSinkId) await this.boostCtx.setSinkId(deviceId).catch((err) => console.warn('[voice] setSinkId', err))
  }
}
