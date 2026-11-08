/** Локальные настройки голоса (хранятся в localStorage этого профиля). */
import type { PttBinding } from '../../../preload/api'
import { denoiseSupported } from './denoise'

export type VoiceMode = 'voice' | 'ptt'
export type NotifyMode = 'all' | 'mentions' | 'none'
/**
 * Шумоподавление микрофона: ai — нейросеть DeepFilterNet3 и речевой шлюз (убирает клавиатуру, щелчки, фон);
 * standard — встроенное в браузер; off — выключено.
 */
export type NoiseMode = 'ai' | 'standard' | 'off'

export type ScreenQuality = '720p30' | '720p60' | '1080p30' | '1080p60' | '1440p30' | '1440p60'
/** detail — текст и код (чёткость важнее плавности); motion — игры и видео. */
export type ScreenContent = 'detail' | 'motion'

export interface ScreenPreset {
  width: number
  height: number
  fps: number
  /** Максимальный битрейт верхнего слоя, бит/с. */
  bitrate: number
}

export const SCREEN_PRESETS: Record<ScreenQuality, ScreenPreset> = {
  '720p30': { width: 1280, height: 720, fps: 30, bitrate: 2_000_000 },
  '720p60': { width: 1280, height: 720, fps: 60, bitrate: 3_000_000 },
  '1080p30': { width: 1920, height: 1080, fps: 30, bitrate: 3_500_000 },
  '1080p60': { width: 1920, height: 1080, fps: 60, bitrate: 5_500_000 },
  '1440p30': { width: 2560, height: 1440, fps: 30, bitrate: 6_000_000 },
  '1440p60': { width: 2560, height: 1440, fps: 60, bitrate: 9_000_000 }
}

export interface VoiceSettings {
  inputDeviceId: string
  outputDeviceId: string
  echoCancellation: boolean
  noiseMode: NoiseMode
  autoGainControl: boolean
  mode: VoiceMode
  pttBinding: PttBinding | null
  /** Задержка отпускания PTT, мс: не обрезает конец фразы. */
  pttReleaseMs: number
  /** Громкость участников 0…2 (по id пользователя; больше 1 — усиление). */
  userVolumes: Record<string, number>
  /** Громкость звука демонстрации экрана 0…2 (по id ведущего). */
  streamVolumes: Record<string, number>
  sounds: boolean
  /** Громкость звуков входа/выхода и прочих сигналов, 0…2 (1 — как раньше). */
  soundVolume: number
  /**
   * Чувствительность микрофона: порог в дБFS (−90…−20), тише которого микрофон молчит;
   * 0 — авто (решает детектор речи или ничего не ограничивать).
   */
  micSensitivity: number
  videoInputDeviceId: string
  screenQuality: ScreenQuality
  screenContent: ScreenContent
  screenAudio: boolean
  /** Уведомления ОС о сообщениях: все, только упоминания, никаких. */
  notifyMode: NotifyMode
  notifySound: boolean
  /** Показывать текст сообщения в уведомлении. */
  notifyPreview: boolean
}

const KEY = 'zvon.voice.v1'

export const DEFAULT_VOICE_SETTINGS: VoiceSettings = {
  inputDeviceId: '',
  outputDeviceId: '',
  echoCancellation: true,
  noiseMode: 'ai',
  autoGainControl: true,
  mode: 'voice',
  pttBinding: null,
  pttReleaseMs: 200,
  userVolumes: {},
  streamVolumes: {},
  sounds: true,
  soundVolume: 1,
  micSensitivity: 0,
  videoInputDeviceId: '',
  screenQuality: '1080p30',
  screenContent: 'detail',
  screenAudio: false,
  notifyMode: 'mentions',
  notifySound: true,
  notifyPreview: true
}

function isMobile(): boolean {
  if (typeof navigator === 'undefined') return false
  return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
}

/** Усиленное шумоподавление доступно в приложении и в Chrome/Edge на компьютере. */
export function aiNoiseAvailable(): boolean {
  return denoiseSupported()
}

/**
 * Режим по умолчанию: на компьютере — усиленное; на телефоне — встроенное (у телефонов оно своё и хорошее,
 * а нейросеть заметно расходует батарею).
 */
function defaultNoiseMode(): NoiseMode {
  return aiNoiseAvailable() && !isMobile() ? 'ai' : 'standard'
}

/** Режим, который реально сработает на этом устройстве. */
export function effectiveNoiseMode(s: VoiceSettings): NoiseMode {
  return s.noiseMode === 'ai' && !aiNoiseAvailable() ? 'standard' : s.noiseMode
}

/** Старые настройки: два флажка (встроенное шумоподавление и RNNoise) вместо режима. */
interface LegacySettings {
  noiseSuppression?: boolean
  rnnoise?: boolean
}

function noiseModeFrom(parsed: Partial<VoiceSettings> & LegacySettings): NoiseMode {
  if (parsed.noiseMode === 'ai' || parsed.noiseMode === 'standard' || parsed.noiseMode === 'off') return parsed.noiseMode
  // Раньше шумоподавление выключали явно — уважаем этот выбор; остальным включаем лучшее из доступного.
  if (parsed.noiseSuppression === false && !parsed.rnnoise) return 'off'
  return defaultNoiseMode()
}

export function loadVoiceSettings(): VoiceSettings {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return { ...DEFAULT_VOICE_SETTINGS, noiseMode: defaultNoiseMode() }
    const { noiseSuppression, rnnoise, ...parsed } = JSON.parse(raw) as Partial<VoiceSettings> & LegacySettings
    return {
      ...DEFAULT_VOICE_SETTINGS,
      ...parsed,
      noiseMode: noiseModeFrom({ ...parsed, noiseSuppression, rnnoise }),
      userVolumes: { ...(parsed.userVolumes ?? {}) },
      streamVolumes: { ...(parsed.streamVolumes ?? {}) },
      mode: parsed.mode === 'ptt' ? 'ptt' : 'voice',
      soundVolume: typeof parsed.soundVolume === 'number' && Number.isFinite(parsed.soundVolume) ? Math.min(2, Math.max(0, parsed.soundVolume)) : 1,
      micSensitivity: typeof parsed.micSensitivity === 'number' && Number.isFinite(parsed.micSensitivity) ? Math.min(0, Math.max(-90, parsed.micSensitivity)) : 0,
      screenQuality: parsed.screenQuality && parsed.screenQuality in SCREEN_PRESETS ? parsed.screenQuality : '1080p30',
      screenContent: parsed.screenContent === 'motion' ? 'motion' : 'detail',
      notifyMode: parsed.notifyMode === 'all' || parsed.notifyMode === 'none' ? parsed.notifyMode : 'mentions'
    }
  } catch {
    return { ...DEFAULT_VOICE_SETTINGS, noiseMode: defaultNoiseMode() }
  }
}

export function saveVoiceSettings(s: VoiceSettings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s))
  } catch {
    /* хранилище недоступно — настройки проживут до перезапуска */
  }
}
