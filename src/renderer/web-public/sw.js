/*
 * Service worker веб-версии Zvon: только push-уведомления. Страницы не кэширует,
 * чтобы обновления сервера доходили сразу.
 */
self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()))

self.addEventListener('push', (event) => {
  let data = {}
  try {
    data = event.data ? event.data.json() : {}
  } catch {
    data = { title: 'Zvon', body: event.data ? event.data.text() : '' }
  }
  const title = data.title || 'Zvon'
  const options = {
    body: data.body || '',
    tag: data.tag || 'zvon',
    renotify: true,
    icon: '/icon.png',
    badge: '/icon.png',
    data: { channelId: data.channelId || null, messageId: data.messageId || null }
  }
  event.waitUntil(
    (async () => {
      // Если приложение открыто и на виду — оно само покажет сообщение, уведомление не нужно.
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      if (windows.some((w) => w.visibilityState === 'visible' && w.focused)) return
      await self.registration.showNotification(title, options)
    })()
  )
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const { channelId, messageId } = event.notification.data || {}
  const url = channelId ? `/#open=${channelId}${messageId ? ':' + messageId : ''}` : '/'
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      const existing = windows[0]
      if (existing) {
        await existing.focus()
        existing.postMessage({ type: 'open', channelId, messageId })
        return
      }
      await self.clients.openWindow(url)
    })()
  )
})
