import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { AppSettings, PttBinding } from '../../../preload/api'
import { LANGUAGES, setLanguage, type Language } from '../i18n'
import { useApp } from '../store/app'
import { updateVoiceSettings } from '../store/voice'
import { aiNoiseAvailable, type NoiseMode } from '../voice/settings'
import { playSound } from '../voice/sounds'
import { diagText, onDiag } from '../voice/diag'
import { Modal } from './Common'
import { IS_WEB } from '../edition'

interface Devices {
  inputs: MediaDeviceInfo[]
  outputs: MediaDeviceInfo[]
  cameras: MediaDeviceInfo[]
}

function useDevices(): Devices {
  const [devices, setDevices] = useState<Devices>({ inputs: [], outputs: [], cameras: [] })
  useEffect(() => {
    let alive = true
    const load = (): void => {
      navigator.mediaDevices
        .enumerateDevices()
        .then((list) => {
          if (!alive) return
          setDevices({
            inputs: list.filter((d) => d.kind === 'audioinput' && d.deviceId !== 'default' && d.deviceId !== 'communications'),
            outputs: list.filter((d) => d.kind === 'audiooutput' && d.deviceId !== 'default' && d.deviceId !== 'communications'),
            cameras: list.filter((d) => d.kind === 'videoinput')
          })
        })
        .catch((err) => console.warn('[settings] enumerateDevices', err))
    }
    load()
    navigator.mediaDevices.addEventListener('devicechange', load)
    return () => {
      alive = false
      navigator.mediaDevices.removeEventListener('devicechange', load)
    }
  }, [])
  return devices
}

/** Живой индикатор уровня микрофона с текущими настройками. */
function MicMeter({ onPermission }: { onPermission: () => void }) {
  const { t } = useTranslation()
  const settings = useApp((s) => s.voiceSettings)
  const [level, setLevel] = useState(0)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let stream: MediaStream | null = null
    let ctx: AudioContext | null = null
    let raf = 0
    let cancelled = false
    ;(async () => {
      try {
        if (!(await window.zvon.ensureMediaAccess('microphone'))) throw new Error('Нет доступа к микрофону')
        stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            deviceId: settings.inputDeviceId ? { exact: settings.inputDeviceId } : undefined,
            echoCancellation: settings.echoCancellation,
            noiseSuppression: settings.noiseMode !== 'off',
            autoGainControl: settings.autoGainControl
          }
        })
        if (cancelled) {
          stream.getTracks().forEach((tr) => tr.stop())
          return
        }
        onPermission()
        ctx = new AudioContext()
        const analyser = ctx.createAnalyser()
        analyser.fftSize = 512
        ctx.createMediaStreamSource(stream).connect(analyser)
        const buf = new Float32Array(analyser.fftSize)
        const tick = (): void => {
          analyser.getFloatTimeDomainData(buf)
          let sum = 0
          for (const v of buf) sum += v * v
          const rms = Math.sqrt(sum / buf.length)
          // Перевод в 0…1 по логарифмической шкале (−60…0 дБ).
          const db = 20 * Math.log10(Math.max(rms, 1e-6))
          setLevel(Math.min(1, Math.max(0, (db + 60) / 60)))
          raf = requestAnimationFrame(tick)
        }
        tick()
        setError(null)
      } catch (err) {
        setError((err as Error).message)
      }
    })()
    return () => {
      cancelled = true
      cancelAnimationFrame(raf)
      stream?.getTracks().forEach((tr) => tr.stop())
      void ctx?.close()
    }
  }, [settings.inputDeviceId, settings.echoCancellation, settings.noiseMode, settings.autoGainControl, onPermission])

  return (
    <div className="mic-meter">
      <div className="field-label">{t('voice.micTest')}</div>
      <div className="meter">
        <div className={level > 0.55 ? 'meter-fill loud' : 'meter-fill'} style={{ width: `${Math.round(level * 100)}%` }} />
      </div>
      <p className="hint">{error ?? t('voice.micTestHint')}</p>
    </div>
  )
}

function PttKeyPicker() {
  const { t } = useTranslation()
  const binding = useApp((s) => s.voiceSettings.pttBinding)
  const support = useApp((s) => s.pttSupport)
  const [recording, setRecording] = useState(false)

  const record = async (): Promise<void> => {
    setRecording(true)
    // Пока ждём клавишу, не даём ей сработать в окне (например, Esc закрыл бы диалог).
    const swallow = (e: KeyboardEvent): void => {
      e.preventDefault()
      e.stopImmediatePropagation()
    }
    if (support?.global) window.addEventListener('keydown', swallow, true)
    try {
      let result: PttBinding | null
      if (support?.global) {
        result = await window.zvon.pttRecord()
      } else {
        result = await new Promise<PttBinding | null>((resolve) => {
          const onKey = (e: KeyboardEvent): void => {
            e.preventDefault()
            e.stopImmediatePropagation()
            window.removeEventListener('keydown', onKey, true)
            resolve(e.code === 'Escape' ? null : { type: 'dom', code: e.code, label: e.code.replace(/^Key|^Digit/, '') })
          }
          window.addEventListener('keydown', onKey, true)
        })
      }
      if (result) updateVoiceSettings({ pttBinding: result })
    } finally {
      window.removeEventListener('keydown', swallow, true)
      setRecording(false)
    }
  }

  return (
    <div className="ptt-picker">
      <div className="field-label">{t('voice.pttKey')}</div>
      <div className="ptt-row">
        <kbd className="ptt-key">{recording ? '…' : (binding?.label ?? t('voice.pttNone'))}</kbd>
        <button className="btn btn-small btn-secondary" disabled={recording} onClick={() => void record()}>
          {t('voice.pttAssign')}
        </button>
      </div>
      {recording && <p className="hint">{t('voice.pttPress')}</p>}
      {support && !support.global && <p className="warning">{t('voice.pttLocalOnly')}</p>}
      {support?.reason && <p className="hint">{support.reason}</p>}
    </div>
  )
}

function VoiceTab() {
  const { t } = useTranslation()
  const settings = useApp((s) => s.voiceSettings)
  const devices = useDevices()
  const [, force] = useState(0)
  const permissionOnce = useRef(false)
  // После первого разрешения у устройств появляются названия — перечитываем список.
  const onPermission = useCallback(() => {
    if (permissionOnce.current) return
    permissionOnce.current = true
    navigator.mediaDevices.dispatchEvent(new Event('devicechange'))
    force((n) => n + 1)
  }, [])

  const noLabels = devices.inputs.length > 0 && devices.inputs.every((d) => !d.label)

  return (
    <div className="settings">
        <label className="field">
          <span className="field-label">{t('voice.inputDevice')}</span>
          <select value={settings.inputDeviceId} onChange={(e) => updateVoiceSettings({ inputDeviceId: e.target.value })}>
            <option value="">{t('voice.defaultDevice')}</option>
            {devices.inputs.map((d, i) => (
              <option key={d.deviceId} value={d.deviceId}>
                {d.label || `${t('voice.inputDevice')} ${i + 1}`}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="field-label">{t('voice.outputDevice')}</span>
          <div className="field-inline">
            <select value={settings.outputDeviceId} onChange={(e) => updateVoiceSettings({ outputDeviceId: e.target.value })}>
              <option value="">{t('voice.defaultDevice')}</option>
              {devices.outputs.map((d, i) => (
                <option key={d.deviceId} value={d.deviceId}>
                  {d.label || `${t('voice.outputDevice')} ${i + 1}`}
                </option>
              ))}
            </select>
            <button className="btn btn-small btn-secondary" onClick={() => playSound('self-join', 0.3)}>
              {t('voice.testSound')}
            </button>
          </div>
        </label>
        <label className="field">
          <span className="field-label">{t('voice.cameraDevice')}</span>
          <select value={settings.videoInputDeviceId} onChange={(e) => updateVoiceSettings({ videoInputDeviceId: e.target.value })}>
            <option value="">{t('voice.defaultDevice')}</option>
            {devices.cameras.map((d, i) => (
              <option key={d.deviceId} value={d.deviceId}>
                {d.label || `${t('voice.cameraDevice')} ${i + 1}`}
              </option>
            ))}
          </select>
        </label>
        {noLabels && <p className="hint">{t('voice.noDevices')}</p>}

        <MicMeter onPermission={onPermission} />

        <div className="field-label">{t('voice.processing')}</div>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={settings.echoCancellation}
            onChange={(e) => updateVoiceSettings({ echoCancellation: e.target.checked })}
          />
          {t('voice.echo')}
        </label>
        <label className="field">
          <span className="field-label">{t('voice.noise')}</span>
          <select value={settings.noiseMode} onChange={(e) => updateVoiceSettings({ noiseMode: e.target.value as NoiseMode })}>
            <option value="ai" disabled={!aiNoiseAvailable()}>
              {t('voice.noiseAi')}
            </option>
            <option value="standard">{t('voice.noiseStandard')}</option>
            <option value="off">{t('voice.noiseOff')}</option>
          </select>
        </label>
        <p className="hint">
          {!aiNoiseAvailable() ? t('voice.noiseAiUnavailable') : settings.noiseMode === 'ai' ? t('voice.noiseAiHint') : t('voice.noiseStandardHint')}
        </p>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={settings.autoGainControl}
            onChange={(e) => updateVoiceSettings({ autoGainControl: e.target.checked })}
          />
          {t('voice.agc')}
        </label>

        <div className="field-label">{t('voice.mode')}</div>
        <div className="radio-row">
          <label className={settings.mode === 'voice' ? 'radio active' : 'radio'}>
            <input type="radio" checked={settings.mode === 'voice'} onChange={() => updateVoiceSettings({ mode: 'voice' })} />
            {t('voice.modeVoice')}
          </label>
          <label className={settings.mode === 'ptt' ? 'radio active' : 'radio'}>
            <input type="radio" checked={settings.mode === 'ptt'} onChange={() => updateVoiceSettings({ mode: 'ptt' })} />
            {t('voice.modePtt')}
          </label>
        </div>
        {settings.mode === 'ptt' && (
          <>
            <PttKeyPicker />
            <label className="field">
              <span className="field-label">{t('voice.pttRelease', { ms: settings.pttReleaseMs })}</span>
              <input
                type="range"
                min={0}
                max={1000}
                step={50}
                value={settings.pttReleaseMs}
                onChange={(e) => updateVoiceSettings({ pttReleaseMs: Number(e.target.value) })}
              />
            </label>
          </>
        )}


      </div>
  )
}

type SettingsTab = 'voice' | 'notify' | 'app'

export function VoiceSettingsDialog({ onClose, initialTab = 'voice' }: { onClose: () => void; initialTab?: SettingsTab }) {
  const { t } = useTranslation()
  const [tab, setTab] = useState<SettingsTab>(initialTab)
  return (
    <Modal title={t('settings.title')} onClose={onClose} wide>
      <div className="tabs">
        <button className={tab === 'voice' ? 'tab active' : 'tab'} onClick={() => setTab('voice')}>
          {t('settings.voice')}
        </button>
        <button className={tab === 'notify' ? 'tab active' : 'tab'} onClick={() => setTab('notify')}>
          {t('settings.notify')}
        </button>
        <button className={tab === 'app' ? 'tab active' : 'tab'} onClick={() => setTab('app')}>
          {t('settings.app')}
        </button>
      </div>
      {tab === 'voice' ? <VoiceTab /> : tab === 'notify' ? <NotifyTab /> : <AppTab />}
    </Modal>
  )
}

function NotifyTab() {
  const { t } = useTranslation()
  const settings = useApp((s) => s.voiceSettings)
  const [permission, setPermission] = useState(typeof Notification !== 'undefined' ? Notification.permission : 'denied')
  return (
    <div className="settings">
      <div className="field-label">{t('settings.notifyMode')}</div>
      <div className="radio-row">
        {(['all', 'mentions', 'none'] as const).map((m) => (
          <label key={m} className={settings.notifyMode === m ? 'radio active' : 'radio'}>
            <input type="radio" checked={settings.notifyMode === m} onChange={() => updateVoiceSettings({ notifyMode: m })} />
            {t(`settings.notify_${m}`)}
          </label>
        ))}
      </div>
      <label className="checkbox">
        <input type="checkbox" checked={settings.notifySound} onChange={(e) => updateVoiceSettings({ notifySound: e.target.checked })} />
        {t('settings.notifySound')}
      </label>
      <label className="checkbox">
        <input type="checkbox" checked={settings.notifyPreview} onChange={(e) => updateVoiceSettings({ notifyPreview: e.target.checked })} />
        {t('settings.notifyPreview')}
      </label>
      <label className="checkbox">
        <input type="checkbox" checked={settings.sounds} onChange={(e) => updateVoiceSettings({ sounds: e.target.checked })} />
        {t('voice.sounds')}
      </label>
      <div className="button-row">
        <button
          className="btn btn-small btn-secondary"
          onClick={() => {
            playSound('mention', 0.2)
            const show = (): void => {
              try {
                new Notification('Zvon', { body: t('settings.notifyTestBody'), silent: true })
              } catch {
                /* уведомления недоступны */
              }
            }
            if (Notification.permission === 'granted') show()
            else void Notification.requestPermission().then((p) => {
              setPermission(p)
              if (p === 'granted') show()
            })
          }}
        >
          {t('settings.notifyTest')}
        </button>
      </div>
      {permission === 'denied' && <p className="warning">{t('settings.notifyDenied')}</p>}
      <p className="hint">{t('settings.notifyHint')}</p>
    </div>
  )
}

function AppTab() {
  const { t, i18n } = useTranslation()
  const boot = useApp((s) => s.boot)
  const [app, setAppSettingsState] = useState<AppSettings | null>(boot?.appSettings ?? null)
  const [error, setError] = useState<string | null>(null)
  const change = (patch: Partial<AppSettings>): void => {
    setError(null)
    window.zvon
      .setAppSettings(patch)
      .then((next) => {
        setAppSettingsState(next)
        useApp.setState((s) => (s.boot ? { boot: { ...s.boot, appSettings: next } } : {}))
      })
      .catch((err: Error) => setError(err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')))
  }
  return (
    <div className="settings">
      {app && !IS_WEB && (
        <>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={app.closeToTray}
              disabled={!boot?.trayAvailable}
              onChange={(e) => change({ closeToTray: e.target.checked })}
            />
            {t('settings.closeToTray')}
          </label>
          {!boot?.trayAvailable && <p className="hint">{t('settings.noTray')}</p>}
          <label className="checkbox">
            <input type="checkbox" checked={app.autostart} onChange={(e) => change({ autostart: e.target.checked })} />
            {t('settings.autostart')}
          </label>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={app.startMinimized}
              disabled={!app.autostart}
              onChange={(e) => change({ startMinimized: e.target.checked })}
            />
            {t('settings.startMinimized')}
          </label>
        </>
      )}
      {error && <div className="error-box">{error}</div>}
      <label className="field">
        <span className="field-label">{t('voice.language')}</span>
        <select value={i18n.language} onChange={(e) => setLanguage(e.target.value as Language)}>
          {Object.entries(LANGUAGES).map(([code, name]) => (
            <option key={code} value={code}>
              {name}
            </option>
          ))}
        </select>
      </label>
      {boot && (
        <p className="hint">
          Zvon {boot.version} · {t('settings.build', { build: __ZVON_BUILD__ })}
          {boot.profile ? ` · профиль «${boot.profile}»` : ''}
        </p>
      )}
      <AudioJournal />
    </div>
  )
}

/** Журнал звука: что происходило с микрофоном и звуком звонка. Его копируют и присылают, когда что-то не работает. */
function AudioJournal() {
  const { t } = useTranslation()
  const [text, setText] = useState(diagText)
  const [copied, setCopied] = useState(false)
  useEffect(
    () =>
      onDiag(() => {
        setText(diagText())
        setCopied(false)
      }),
    []
  )
  const copy = (): void => {
    navigator.clipboard.writeText(diagText()).then(
      () => setCopied(true),
      () => undefined
    )
  }
  return (
    <details className="diag">
      <summary>{t('settings.audioJournal')}</summary>
      <p className="hint">{t('settings.audioJournalHint')}</p>
      <button className="btn btn-small btn-secondary" onClick={copy}>
        {copied ? t('settings.journalCopied') : t('settings.journalCopy')}
      </button>
      <pre className="diag-log">{text}</pre>
    </details>
  )
}
