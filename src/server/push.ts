/**
 * Push-уведомления для веб-версии (телефон с закрытой вкладкой, приложение на главном экране).
 * Ключи VAPID создаются один раз и хранятся в настройках сервера; подписки браузеров — в БД.
 * Электрон-приложение push не использует: у него есть уведомления ОС.
 */
import webpush from 'web-push'
import type { PushSubscriptionJson } from '../shared/types'
import type { ZvonDb } from './db'
import type { Logger } from './logger'

export interface PushPayload {
  title: string
  body: string
  /** Куда вести по нажатию: канал и сообщение. */
  channelId: string
  messageId: number
  /** Одинаковый tag заменяет предыдущее уведомление того же канала. */
  tag: string
}

export class PushService {
  readonly publicKey: string | null = null

  constructor(
    private db: ZvonDb,
    private log: Logger
  ) {
    try {
      let publicKey = db.getSetting('vapidPublicKey')
      let privateKey = db.getSetting('vapidPrivateKey')
      if (!publicKey || !privateKey) {
        const keys = webpush.generateVAPIDKeys()
        publicKey = keys.publicKey
        privateKey = keys.privateKey
        db.setSetting('vapidPublicKey', publicKey)
        db.setSetting('vapidPrivateKey', privateKey)
        log.info('Созданы ключи VAPID для push-уведомлений')
      }
      webpush.setVapidDetails('mailto:zvon@localhost', publicKey, privateKey)
      this.publicKey = publicKey
    } catch (err) {
      log.warn('Push-уведомления недоступны', err)
    }
  }

  subscribe(userId: string, subscription: PushSubscriptionJson): void {
    this.db.addPushSubscription(userId, subscription)
  }

  unsubscribe(endpoint: string): void {
    this.db.removePushSubscription(endpoint)
  }

  /** Отправляет уведомление на все устройства перечисленных участников. Ошибки не роняют сервер. */
  notify(userIds: string[], payload: PushPayload): void {
    if (!this.publicKey || userIds.length === 0) return
    const subs = this.db.pushSubscriptionsOf([...new Set(userIds)])
    if (subs.length === 0) return
    const body = JSON.stringify(payload)
    for (const { subscription } of subs) {
      webpush.sendNotification(subscription, body, { TTL: 60 * 60, urgency: 'high' }).catch((err: { statusCode?: number; message?: string }) => {
        // Подписка отозвана (приложение удалено, разрешение снято) — забываем её.
        if (err.statusCode === 404 || err.statusCode === 410) {
          this.db.removePushSubscription(subscription.endpoint)
          return
        }
        this.log.warn(`Push не доставлен (${err.statusCode ?? '?'}): ${err.message ?? err}`)
      })
    }
  }
}
