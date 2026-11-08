/**
 * Push-уведомления веб-версии: service worker + подписка браузера, которую сервер использует,
 * чтобы разбудить телефон, когда вкладка закрыта. В приложении Electron не нужны — там уведомления ОС.
 */
import { IS_WEB } from '../edition'
import { getApp, setApp } from '../store/app'
import { jumpToMessage, selectChannel, serverRequest } from '../store/session'

/** Канал и сообщение, которые нужно открыть после входа (пришли из нажатия на уведомление). */
let pendingOpen: { channelId: string; messageId: number | null } | null = null

function openTarget(channelId: string, messageId: number | null): void {
  if (!getApp().me) {
    pendingOpen = { channelId, messageId }
    return
  }
  if (messageId) void jumpToMessage(channelId, messageId)
  else selectChannel(channelId)
}

/** После входа: открыть то, на что нажали в уведомлении, пока приложение было закрыто. */
export function applyPendingOpen(): void {
  const target = pendingOpen
  pendingOpen = null
  if (target) setTimeout(() => openTarget(target.channelId, target.messageId), 300)
}

/** Слушает нажатия на уведомления (сообщения от service worker и адрес вида #open=канал:сообщение). */
export function initPushNavigation(): void {
  if (!pushSupported()) return
  const m = /^#open=([^:]+)(?::(\d+))?$/.exec(location.hash)
  if (m) {
    pendingOpen = { channelId: m[1], messageId: m[2] ? Number(m[2]) : null }
    history.replaceState(null, '', location.pathname)
  }
  navigator.serviceWorker.addEventListener('message', (e: MessageEvent<{ type?: string; channelId?: string; messageId?: number | null }>) => {
    if (e.data?.type === 'open' && e.data.channelId) openTarget(e.data.channelId, e.data.messageId ?? null)
  })
}

const SW_URL = '/sw.js'

export function pushSupported(): boolean {
  return IS_WEB && typeof navigator !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window
}

/** iPhone и iPad: push работает только у приложения, добавленного на экран «Домой». */
export function pushNeedsHomeScreen(): boolean {
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  const standalone = window.matchMedia('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true
  return ios && !standalone
}

function keyToBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64url.length % 4)) % 4)
  const raw = atob((base64url + padding).replace(/-/g, '+').replace(/_/g, '/'))
  const out = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i)
  return out
}

async function registration(): Promise<ServiceWorkerRegistration> {
  const existing = await navigator.serviceWorker.getRegistration('/')
  return existing ?? (await navigator.serviceWorker.register(SW_URL, { scope: '/' }))
}

function toJson(sub: PushSubscription): { endpoint: string; keys: { p256dh: string; auth: string } } | null {
  const j = sub.toJSON()
  if (!j.endpoint || !j.keys?.p256dh || !j.keys.auth) return null
  return { endpoint: j.endpoint, keys: { p256dh: j.keys.p256dh, auth: j.keys.auth } }
}

/** После входа: если подписка уже есть, напоминаем о ней серверу (сервер мог её потерять). */
export async function syncPushSubscription(): Promise<void> {
  if (!pushSupported() || !getApp().pushKey) return
  try {
    const reg = await navigator.serviceWorker.getRegistration('/')
    const sub = await reg?.pushManager.getSubscription()
    const json = sub ? toJson(sub) : null
    setApp({ pushEnabled: Boolean(json) && Notification.permission === 'granted' })
    if (json && Notification.permission === 'granted') await serverRequest('push-subscribe', { subscription: json })
  } catch (err) {
    console.warn('[push] не удалось проверить подписку', err)
  }
}

/** Включить push на этом устройстве (нужно нажатие пользователя). Возвращает текст ошибки или null. */
export async function enablePush(): Promise<string | null> {
  const key = getApp().pushKey
  if (!pushSupported() || !key) return 'Push-уведомления недоступны'
  try {
    const permission = await Notification.requestPermission()
    if (permission !== 'granted') return 'Разрешение на уведомления не дано'
    const reg = await registration()
    await navigator.serviceWorker.ready
    const sub =
      (await reg.pushManager.getSubscription()) ??
      (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyToBytes(key) }))
    const json = toJson(sub)
    if (!json) return 'Браузер не выдал ключи подписки'
    await serverRequest('push-subscribe', { subscription: json })
    setApp({ pushEnabled: true })
    return null
  } catch (err) {
    return (err as Error).message
  }
}

export async function disablePush(): Promise<void> {
  try {
    const reg = await navigator.serviceWorker.getRegistration('/')
    const sub = await reg?.pushManager.getSubscription()
    if (sub) {
      await serverRequest('push-unsubscribe', { endpoint: sub.endpoint }).catch(() => undefined)
      await sub.unsubscribe()
    }
  } catch (err) {
    console.warn('[push] не удалось отключить', err)
  }
  setApp({ pushEnabled: false })
}
