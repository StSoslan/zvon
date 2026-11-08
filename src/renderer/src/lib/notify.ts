/**
 * Уведомления ОС о новых сообщениях и звук сообщения.
 * Не беспокоим, если человек и так смотрит на этот канал.
 */
import type { Channel, Message } from '../../../shared/types'
import { getApp } from '../store/app'
import { playSound } from '../voice/sounds'

const MAX_BODY = 140

function shortBody(m: Message): string {
  if (m.content.trim()) return m.content.length > MAX_BODY ? `${m.content.slice(0, MAX_BODY)}…` : m.content
  const n = m.attachments.length
  if (n === 0) return ''
  const kind = m.attachments[0].kind
  if (n === 1) return kind === 'image' ? '📷 Фото' : kind === 'video' ? '🎬 Видео' : `📎 ${m.attachments[0].name}`
  return `📎 Файлов: ${n}`
}

/**
 * @param mentioned сообщение касается лично меня: упоминание, ответ на моё, личная переписка
 */
export function notifyIncoming(m: Message, mentioned: boolean, channel: Channel | undefined, onOpen: () => void): void {
  const s = getApp()
  const settings = s.voiceSettings
  if (m.authorId === s.me?.id) return
  const visible = s.windowFocused && s.mainView === 'chat' && s.currentChannelId === m.channelId
  if (visible) return

  const wanted = settings.notifyMode === 'all' || (settings.notifyMode === 'mentions' && mentioned)
  if (!wanted) return

  if (settings.notifySound && !s.selfDeafened) playSound(mentioned ? 'mention' : 'message', 0.12)
  if (mentioned) window.zvon.requestAttention()

  // Пока окно активно, хватает звука и счётчика у канала — всплывающее окно не нужно.
  if (s.windowFocused) return
  try {
    const author = s.users[m.authorId]?.nickname ?? m.authorName
    const isDm = channel?.type === 'dm'
    const where = isDm ? '' : ` в #${channel?.name ?? ''}`
    const title = isDm
      ? author
      : m.replyTo && m.replyTo.authorId === s.me?.id
        ? `${author} ответил(а) вам${where}`
        : mentioned
          ? `${author} упомянул(а) вас${where}`
          : `${author}${where}`
    const n = new Notification(title, {
      body: settings.notifyPreview ? shortBody(m) : 'Новое сообщение',
      tag: `zvon-${m.channelId}`,
      silent: true
    })
    n.onclick = () => {
      window.zvon.focusWindow()
      onOpen()
      n.close()
    }
  } catch (err) {
    console.warn('[notify] уведомление не показано', err)
  }
}
