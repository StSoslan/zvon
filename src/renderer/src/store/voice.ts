/**
 * Действия голоса: вход/выход, mute/deafen, PTT, громкость участников,
 * восстановление после обрывов и перезапуска медиасервера.
 */
import type { PttBinding } from '../../../preload/api'
import type { ServerSnapshot, VoiceState } from '../../../shared/types'
import type { ConnStatus, ZvonClient } from '../net/client'
import { MAX_VOLUME, VoiceEngine, type ScreenShareOptions } from '../voice/engine'
import { saveVoiceSettings, type VoiceSettings } from '../voice/settings'
import { playSound, resumeSounds, setSoundsOutput, type SoundName } from '../voice/sounds'
import { diag, errText } from '../voice/diag'
import { closeAllPopouts, setPopoutWant, syncPopouts } from '../lib/popout'
import { getApp, setApp } from './app'

let engine: VoiceEngine | null = null
let unsubs: Array<() => void> = []
let rejoinTimer: ReturnType<typeof setTimeout> | null = null
let rejoinAttempt = 0
let globalInit = false
let currentClient: ZvonClient | null = null

const MAX_REJOIN_ATTEMPTS = 8

function sound(name: SoundName): void {
  if (getApp().voiceSettings.sounds) playSound(name)
}

/* ======================= подключение к сессии ======================= */

export function attachVoice(client: ZvonClient): void {
  detachVoice()
  currentClient = client
  engine = new VoiceEngine(
    (type, data) => client.request(type, data),
    {
      onStatus: (voiceStatus, voiceError) => {
        if (voiceStatus !== getApp().voiceStatus) diag(`звонок: ${voiceStatus}${voiceError ? ` (${voiceError})` : ''}`)
        setCallAudioSession(voiceStatus === 'connecting' || voiceStatus === 'connected')
        setApp({ voiceStatus, voiceError })
      },
      onMicError: (micError) => setApp({ micError }),
      onMicInterrupted,
      onFatalTransport: () => scheduleRejoin(500),
      onVideos: (remoteVideos) => {
        setApp({ remoteVideos })
        syncPopouts(remoteVideos)
      },
      onLocalMedia: (localMedia) => setApp({ localMedia })
    },
    () => getApp().voiceSettings
  )
  setPopoutWant((consumerId, viewer, layer) => engine?.wantVideo(consumerId, viewer, layer))
  const s = getApp()
  engine.setMuted(s.selfMuted)
  engine.setDeafened(s.selfDeafened)

  unsubs = [
    client.on('voice-state', ({ userId, state }) => onVoiceState(userId, state)),
    client.on('new-producer', (p) => {
      if (engine && p.channelId === engine.channelId) void engine.consume(p)
    }),
    client.on('producer-closed', ({ producerId }) => engine?.onProducerClosed(producerId)),
    client.on('consumer-closed', ({ consumerId }) => engine?.onConsumerClosed(consumerId)),
    client.on('speaking', ({ channelId, levels }) => setApp((st) => ({ speaking: { ...st.speaking, [channelId]: levels } }))),
    client.on('consumer-layers', ({ consumerId, spatialLayer }) => engine?.onConsumerLayers(consumerId, spatialLayer)),
    client.on('voice-reset', ({ reason }) => {
      console.warn('[voice] сервер сбросил голос:', reason)
      if (getApp().voiceChannelId) {
        // Камеру и демонстрацию не выключаем: после перезахода они опубликуются снова.
        engine?.closeLocal(true)
        setApp({ voiceStatus: 'reconnecting', speaking: {} })
        scheduleRejoin(2500)
      }
    })
  ]
}

export function detachVoice(): void {
  for (const u of unsubs) u()
  unsubs = []
  if (rejoinTimer) clearTimeout(rejoinTimer)
  rejoinTimer = null
  rejoinAttempt = 0
  closeAllPopouts()
  engine?.closeLocal()
  engine = null
  currentClient = null
}

function onVoiceState(userId: string, state: VoiceState | null): void {
  const s = getApp()
  const prev = s.voiceStates[userId]
  const myChannel = s.voiceChannelId
  if (myChannel && userId !== s.me?.id && s.voiceStatus === 'connected') {
    if (state?.channelId === myChannel && prev?.channelId !== myChannel) sound('join')
    if (prev?.channelId === myChannel && state?.channelId !== myChannel) sound('leave')
  }
  setApp((st) => {
    const voiceStates = { ...st.voiceStates }
    if (state) voiceStates[userId] = state
    else delete voiceStates[userId]
    return { voiceStates }
  })
}

/** Вход (или повторный вход после обрыва) завершён: сообщаем серверу наш mute/deafen. */
async function syncSelfState(client: ZvonClient | null): Promise<void> {
  const s = getApp()
  if (!client || (!s.selfMuted && !s.selfDeafened)) return
  try {
    await client.request('voice-state-update', { muted: s.selfMuted, deafened: s.selfDeafened })
  } catch (err) {
    console.warn('[voice] не удалось отправить состояние микрофона', err)
  }
}


/** Снимок сервера получен (первый вход или после переподключения WebSocket). */
export function onVoiceWelcome(snapshot: ServerSnapshot, isReconnect: boolean): void {
  const voiceStates: Record<string, VoiceState> = {}
  for (const v of snapshot.voiceStates) voiceStates[v.userId] = v
  setApp({ voiceStates, serverVoiceError: snapshot.voiceError, speaking: {} })
  if (isReconnect && getApp().voiceChannelId) {
    // Сервер закрыл медиа старого подключения — заходим заново.
    rejoinAttempt = 0
    scheduleRejoin(0)
  }
}

export function onConnStatusForVoice(status: ConnStatus): void {
  if (status === 'reconnecting' && getApp().voiceChannelId) setApp({ voiceStatus: 'reconnecting' })
}

function scheduleRejoin(delayMs: number): void {
  if (rejoinTimer) clearTimeout(rejoinTimer)
  rejoinTimer = setTimeout(() => {
    rejoinTimer = null
    void rejoin()
  }, delayMs)
}

async function rejoin(): Promise<void> {
  const channelId = getApp().voiceChannelId
  if (!engine || !channelId) return
  setApp({ voiceStatus: 'reconnecting' })
  try {
    await engine.join(channelId)
    rejoinAttempt = 0
    await syncSelfState(currentClient)
  } catch (err) {
    rejoinAttempt++
    if (rejoinAttempt >= MAX_REJOIN_ATTEMPTS) {
      setApp({ voiceStatus: 'error', voiceError: `Не удалось вернуться в голосовой канал: ${(err as Error).message}` })
      return
    }
    scheduleRejoin(Math.min(15_000, 1000 * 2 ** rejoinAttempt))
  }
}

/* ======================= действия пользователя ======================= */

export async function joinVoice(channelId: string): Promise<void> {
  const s = getApp()
  if (!engine) return
  if (s.voiceChannelId === channelId && (s.voiceStatus === 'connected' || s.voiceStatus === 'connecting')) {
    setApp({ mainView: 'voice' })
    return
  }
  if (s.serverVoiceError) {
    setApp({ voiceStatus: 'error', voiceError: `Голос на сервере недоступен: ${s.serverVoiceError}` })
    return
  }
  if (rejoinTimer) clearTimeout(rejoinTimer)
  rejoinTimer = null
  // Переход в другой канал выключает камеру и демонстрацию.
  if (s.voiceChannelId && s.voiceChannelId !== channelId) await engine.leave()
  setApp({ voiceChannelId: channelId, voiceError: null, micError: null, mediaError: null, speaking: {}, focusedTile: null, mainView: 'voice' })
  try {
    await engine.join(channelId)
    if (getApp().voiceChannelId !== channelId) return
    sound('self-join')
    await syncSelfState(currentClient)
  } catch (err) {
    if (getApp().voiceChannelId === channelId) {
      setApp({ voiceChannelId: null, voiceStatus: 'error', voiceError: (err as Error).message, mainView: 'chat' })
    }
  }
}

export async function leaveVoice(): Promise<void> {
  if (rejoinTimer) clearTimeout(rejoinTimer)
  rejoinTimer = null
  const was = getApp().voiceChannelId
  setApp((s) => ({
    voiceChannelId: null,
    voiceStatus: 'idle',
    voiceError: null,
    micError: null,
    mediaError: null,
    speaking: {},
    focusedTile: null,
    mainView: 'chat',
    currentChannelId: s.currentChannelId ?? s.channels.find((c) => c.type === 'text')?.id ?? null
  }))
  if (was) sound('self-leave')
  closeAllPopouts()
  await engine?.leave()
}

async function pushSelfState(): Promise<void> {
  const s = getApp()
  if (!s.voiceChannelId || s.voiceStatus !== 'connected' || !currentClient) return
  try {
    await currentClient.request('voice-state-update', { muted: s.selfMuted, deafened: s.selfDeafened })
  } catch (err) {
    console.warn('[voice] voice-state-update', err)
  }
}

export function toggleMute(): void {
  const s = getApp()
  // Как в Discord: включение микрофона снимает и «оглушение».
  if (s.selfDeafened && s.selfMuted) {
    setApp({ selfMuted: false, selfDeafened: false })
    engine?.setDeafened(false)
    engine?.setMuted(false)
    sound('undeafen')
  } else {
    const muted = !s.selfMuted
    setApp({ selfMuted: muted })
    engine?.setMuted(muted)
    sound(muted ? 'mute' : 'unmute')
  }
  void pushSelfState()
}

export function toggleDeafen(): void {
  const s = getApp()
  const deafened = !s.selfDeafened
  // Оглушение всегда выключает микрофон; снятие возвращает микрофон.
  setApp({ selfDeafened: deafened, selfMuted: deafened })
  engine?.setDeafened(deafened)
  engine?.setMuted(deafened)
  sound(deafened ? 'deafen' : 'undeafen')
  void pushSelfState()
}

export function setUserVolume(userId: string, volume: number): void {
  const v = Math.min(MAX_VOLUME, Math.max(0, volume))
  updateVoiceSettings({ userVolumes: { ...getApp().voiceSettings.userVolumes, [userId]: v } })
  engine?.refreshVolumes()
}

/** Громкость звука демонстрации экрана участника (отдельно от его голоса). */
export function setStreamVolume(userId: string, volume: number): void {
  const v = Math.min(MAX_VOLUME, Math.max(0, volume))
  updateVoiceSettings({ streamVolumes: { ...getApp().voiceSettings.streamVolumes, [userId]: v } })
  engine?.refreshVolumes()
}

export function updateVoiceSettings(patch: Partial<VoiceSettings>): void {
  const prev = getApp().voiceSettings
  const next = { ...prev, ...patch }
  setApp({ voiceSettings: next })
  saveVoiceSettings(next)

  const micChanged =
    prev.inputDeviceId !== next.inputDeviceId ||
    prev.echoCancellation !== next.echoCancellation ||
    prev.noiseMode !== next.noiseMode ||
    prev.autoGainControl !== next.autoGainControl
  if (micChanged) void engine?.restartMic()
  if (prev.outputDeviceId !== next.outputDeviceId) {
    void engine?.setOutputDevice(next.outputDeviceId)
    setSoundsOutput(next.outputDeviceId)
  }
  if (prev.mode !== next.mode || prev.pttBinding !== next.pttBinding) {
    void configurePtt()
    engine?.refreshTransmit()
  }
}

/* ======================= push-to-talk ======================= */

function onPtt(pressed: boolean): void {
  const s = getApp()
  if (s.voiceSettings.mode !== 'ptt' || s.pttPressed === pressed) return
  setApp({ pttPressed: pressed })
  engine?.setPtt(pressed)
}

async function configurePtt(): Promise<void> {
  const { mode, pttBinding } = getApp().voiceSettings
  if (mode !== 'ptt') onPtt(false)
  try {
    await window.zvon.pttConfigure(mode === 'ptt', pttBinding)
  } catch (err) {
    console.warn('[voice] не удалось настроить PTT', err)
  }
}

function domBinding(): Extract<PttBinding, { type: 'dom' }> | null {
  const s = getApp().voiceSettings
  return s.mode === 'ptt' && s.pttBinding?.type === 'dom' ? s.pttBinding : null
}

/**
 * Safari 16.4+: общий режим звука «запись и воспроизведение» на время звонка. Тогда видео из чата
 * играет вместе со звонком и не переключает телефон в режим «только воспроизведение», который глушит микрофон.
 */
type AudioSessionNavigator = Navigator & {
  audioSession?: { type: string; state?: string; addEventListener?: (type: 'statechange', listener: () => void) => void }
}

export function setCallAudioSession(inCall: boolean): void {
  const session = (navigator as AudioSessionNavigator).audioSession
  if (!session) return
  try {
    session.type = inCall ? 'play-and-record' : 'auto'
  } catch {
    /* старый Safari */
  }
}

/** iPhone и iPad: любой браузер там работает на движке Safari и делит звук между звонком и видео по-своему. */
const IS_IOS =
  typeof navigator !== 'undefined' &&
  (/iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1))

/* ======================= звонок и видео из чата ======================= */

/*
 * Как это устроено на iPhone (Safari). В момент запуска видео со звуком Safari сам ставит на паузу
 * остальной звук страницы — в том числе голоса собеседников. Но запретить он может только запуск видео
 * «поверх», а не наоборот: звук звонка разрешено вернуть, пока видео играет. Поэтому:
 *  1) как только видео пошло, возвращаем голоса собеседников — видео играет поверх звонка;
 *  2) если Safari в ответ всё-таки остановил видео, больше так не делаем: звонок молчит, пока идёт видео,
 *     и возвращается после него;
 *  3) после видео и по любому нажатию на экран проверяем звонок и чиним его. Нажатие важно:
 *     Safari надёжно запускает звук только в ответ на действие пользователя.
 * На других устройствах звонок просто возобновляется после остановки видео.
 */

/** Safari не дал играть видео и звонку одновременно (см. выше, пункт 2). До перезагрузки страницы. */
let overlayBlocked = false
/** Видео, поверх которого мы только что вернули звук звонка, и когда. */
let overlaidEl: HTMLMediaElement | null = null
let overlaidAt = 0
/** Последнее касание экрана: пауза сразу после него — это действие пользователя, а не Safari. */
let lastGestureAt = 0
/** После остановки видео первое же нажатие заново запускает звук звонка — даже если он выглядит исправным. */
let recoverOnGesture = false
/** Одно касание приходит тремя событиями (pointerdown, touchend, click) — чиним звонок не чаще раза в полсекунды. */
let lastRecoverAt = 0

let pageMediaCount = 0
let recoverTimer: ReturnType<typeof setTimeout> | null = null

/** Играет ли на странице видео или звук со звуком (кроме звонка) — например, видео из чата. */
function pageMediaPlaying(): boolean {
  for (const el of document.querySelectorAll<HTMLMediaElement>('video, audio')) {
    if (!el.paused && !el.ended && !el.muted && el.volume > 0) return true
  }
  return false
}

/** Можно ли сейчас запускать звук звонка, не отнимая его у видео из чата. */
function callMayPlay(): boolean {
  return !pageMediaPlaying() || (IS_IOS && !overlayBlocked)
}

function resumeCallAudio(): void {
  if (!engine || !callMayPlay()) return
  engine.resumePlayback()
  resumeSounds()
}

/** Видео или аудио из чата реально пошло (событие playing). На iPhone возвращаем звук звонка поверх него. */
export function notifyPageMediaPlaying(el: HTMLMediaElement): void {
  if (!IS_IOS || overlayBlocked || !engine?.inChannel) return
  // Небольшая задержка: Safari ставит звонок на паузу в момент запуска видео.
  setTimeout(() => {
    if (!engine?.inChannel || el.paused || el.ended || overlayBlocked) return
    diag(`видео играет — возвращаю звук звонка поверх него (на паузе: ${engine.playbackStalled ? 'да' : 'нет'})`)
    overlaidEl = el
    overlaidAt = Date.now()
    engine.resumePlayback()
    resumeSounds()
  }, 250)
}

/**
 * Видео или аудио из чата начало (play) или перестало играть (pause, ended, убрано со страницы).
 * После остановки проверяем и чиним звук звонка.
 */
export function notifyPageMedia(playing: boolean, el?: HTMLMediaElement): void {
  pageMediaCount = Math.max(0, pageMediaCount + (playing ? 1 : -1))
  if (engine?.inChannel) diag(`${el?.tagName === 'AUDIO' ? 'аудио' : 'видео'} из чата: ${playing ? 'запуск' : 'остановка'}`)
  if (recoverTimer) clearTimeout(recoverTimer)
  recoverTimer = null
  if (!engine) return

  if (!playing && el && el === overlaidEl) {
    const now = Date.now()
    // Видео остановилось сразу после того, как мы вернули звук звонка, и человек экрана не касался —
    // значит, его остановил Safari: вместе они у него не играют.
    if (!el.ended && now - overlaidAt < 1200 && now - lastGestureAt > 700) {
      overlayBlocked = true
      diag('Safari остановил видео, когда вернулся звук звонка — на время видео звонок будет молчать')
      engine.pausePlayback()
      el.play().catch((err) => diag(`видео не возобновилось: ${errText(err)}`))
      overlaidEl = null
      return
    }
    overlaidEl = null
  }
  if (playing || pageMediaCount > 0) return

  recoverTimer = setTimeout(() => {
    recoverTimer = null
    if (pageMediaCount > 0 || !engine?.inChannel) return
    micRecoveries = 0
    recoverOnGesture = IS_IOS
    void engine.recoverAudio()
    resumeSounds()
  }, 400)
}

/**
 * Нажатие на экран или клавишу. Если звонок молчит (звук на паузе, микрофон приглушён) или только что
 * закончилось видео — чиним звонок прямо сейчас, пока Safari считает это действием пользователя.
 */
function onUserGesture(): void {
  lastGestureAt = Date.now()
  if (!engine?.inChannel || !callMayPlay()) return
  if (!recoverOnGesture && !engine.playbackStalled && !engine.micInterrupted) return
  if (lastGestureAt - lastRecoverAt < 500) return
  lastRecoverAt = lastGestureAt
  recoverOnGesture = false
  micRecoveries = 0
  void engine.recoverAudio()
  resumeSounds()
}

const MAX_MIC_RECOVERIES = 3
let micRecoverTimer: ReturnType<typeof setTimeout> | null = null
let micRecoveries = 0

/**
 * iPhone приглушает микрофон, когда звук забирает что-то другое (видео, Siri, входящий звонок),
 * и часто сам его не возвращает. Тогда переоткрываем микрофон сами. Попыток подряд — не больше трёх,
 * чтобы не дёргать микрофон, если его держит система; счётчик сбрасывают нажатие и возврат на страницу.
 */
function scheduleMicRecovery(delayMs: number): void {
  if (!IS_IOS || micRecoverTimer) return
  micRecoverTimer = setTimeout(() => {
    micRecoverTimer = null
    if (!engine?.micInterrupted || micRecoveries >= MAX_MIC_RECOVERIES) return
    // Страница скрыта или звук сейчас у видео — вернём микрофон, когда страницу откроют или видео остановится.
    if (document.visibilityState !== 'visible' || !callMayPlay()) return
    micRecoveries++
    diag(`переоткрываю приглушённый микрофон (попытка ${micRecoveries})`)
    void engine.restartMic('auto')
  }, delayMs)
}

function onMicInterrupted(interrupted: boolean): void {
  if (interrupted) {
    scheduleMicRecovery(1500)
    return
  }
  micRecoveries = 0
  // Микрофон вернулся — вместе с ним мог вернуться и звук собеседников.
  resumeCallAudio()
}

/**
 * Следит, чтобы звонок не остался без звука: возобновляет его по нажатию, после остановки видео,
 * при возврате звуковой сессии телефона и на всякий случай раз в 2 секунды.
 */
function initPlaybackGuard(): void {
  const onMediaStop = (e: Event): void => {
    if (e.target instanceof HTMLMediaElement) setTimeout(resumeCallAudio, 300)
  }
  document.addEventListener('pause', onMediaStop, true)
  document.addEventListener('ended', onMediaStop, true)
  // touchend и click Safari считает действием пользователя (pointerdown — нет), поэтому слушаем все три.
  for (const type of ['pointerdown', 'touchend', 'click', 'keydown'] as const) {
    document.addEventListener(type, onUserGesture, { capture: true, passive: true })
  }
  setInterval(() => {
    if (engine?.playbackStalled) resumeCallAudio()
    if (engine?.micInterrupted) scheduleMicRecovery(0)
  }, 2000)
  // Телефон сообщает, когда звук у страницы отобрали (звонок, Siri) и когда вернули.
  const session = (navigator as AudioSessionNavigator).audioSession
  session?.addEventListener?.('statechange', () => {
    diag(`звуковая сессия телефона: ${session.state ?? '?'}`)
    if (session.state === 'active') {
      resumeCallAudio()
      if (engine?.micInterrupted) scheduleMicRecovery(500)
    }
  })
}

/** Один раз при запуске приложения: PTT из main-процесса и запасной вариант на клавишах окна. */
export async function initVoiceGlobal(): Promise<void> {
  if (globalInit) return
  globalInit = true
  window.zvon.onPttChange(onPtt)
  // Свёрнутое или скрытое окно не смотрит видео — приём ставится на паузу.
  document.addEventListener('visibilitychange', () => {
    engine?.setPageVisible(document.visibilityState === 'visible')
    if (engine?.inChannel) diag(`страница ${document.visibilityState === 'visible' ? 'снова открыта' : 'скрыта'}`)
    if (document.visibilityState === 'visible') {
      resumeCallAudio()
      // Вернулись в браузер (после звонка по телефону, другого приложения) — микрофон мог остаться приглушённым.
      micRecoveries = 0
      if (engine?.micInterrupted) scheduleMicRecovery(300)
    }
  })
  initPlaybackGuard()
  window.addEventListener('keydown', (e) => {
    const b = domBinding()
    if (b && e.code === b.code && !e.repeat) onPtt(true)
  })
  window.addEventListener('keyup', (e) => {
    const b = domBinding()
    if (b && e.code === b.code) onPtt(false)
  })
  // Окно потеряло фокус — «клавиша окна» больше не удерживается.
  window.addEventListener('blur', () => {
    if (domBinding()) onPtt(false)
  })
  setSoundsOutput(getApp().voiceSettings.outputDeviceId)
  try {
    setApp({ pttSupport: await window.zvon.pttSupport() })
  } catch (err) {
    console.warn('[voice] pttSupport', err)
  }
  await configurePtt()
}

/* ======================= видео ======================= */

export function showVoiceView(): void {
  if (getApp().voiceChannelId) setApp({ mainView: 'voice' })
}

export async function toggleCamera(): Promise<void> {
  if (!engine) return
  setApp({ mediaError: null })
  try {
    if (getApp().localMedia.camera) await engine.stopCamera()
    else {
      await engine.startCamera()
      showVoiceView()
    }
  } catch (err) {
    setApp({ mediaError: (err as Error).message })
  }
}

export function openScreenPicker(): void {
  if (!getApp().voiceChannelId) return
  setApp({ screenPickerOpen: true, mediaError: null })
}

export function closeScreenPicker(): void {
  setApp({ screenPickerOpen: false })
}

export async function startScreenShare(opts: ScreenShareOptions): Promise<void> {
  if (!engine) return
  setApp({ screenPickerOpen: false, mediaError: null })
  try {
    const { audioWarning } = await engine.startScreen(opts)
    setApp({ mediaError: audioWarning })
    showVoiceView()
  } catch (err) {
    setApp({ mediaError: (err as Error).message })
  }
}

export async function stopScreenShare(): Promise<void> {
  await engine?.stopScreen()
}

/** Плитка/окно сообщает, что смотрит поток (layer) или перестало (null). */
export function wantVideo(consumerId: string, viewer: string, layer: number | null): void {
  engine?.wantVideo(consumerId, viewer, layer)
}

export function setManualLayer(consumerId: string, layer: number | null): void {
  engine?.setManualLayer(consumerId, layer)
}

export function setWatching(userId: string, watch: boolean): void {
  setApp((s) => {
    const watching = { ...s.watching }
    if (watch) watching[userId] = true
    else delete watching[userId]
    return { watching }
  })
}

export function setFocusedTile(tile: string | null): void {
  setApp({ focusedTile: tile })
}
