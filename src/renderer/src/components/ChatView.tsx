import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { TIMINGS } from '../../../shared/constants'
import type { Channel, Message, UserInfo } from '../../../shared/types'
import { dayKey, formatDay } from '../lib/format'
import { useApp, type PendingMessage } from '../store/app'
import { discardPending, dismissNewMark, dmPartner, jumpToMessage, loadOlder, markChannelRead, openSearch, retryPending } from '../store/session'
import { Avatar } from './Common'
import { Attachments } from './Attachments'
import { Composer } from './Composer'
import { formatSize } from '../lib/files'
import { addFiles } from '../store/uploads'
import { ArrowDownIcon, ChatIcon, HashIcon, RetryIcon, SearchIcon, TrashIcon } from './Icons'
import { MessageItem, ReplyQuote } from './MessageItem'
import { SearchPanel } from './SearchPanel'

const EMPTY: Message[] = []
const EMPTY_PENDING: PendingMessage[] = []

export function ChatView() {
  const { t } = useTranslation()
  const channelId = useApp((s) => s.currentChannelId)
  const channels = useApp((s) => s.channels)
  const usersMap = useApp((s) => s.users)
  const myId = useApp((s) => s.me?.id)
  const searchOpen = useApp((s) => s.search.open)
  const users = useMemo(() => Object.values(usersMap), [usersMap])
  const channel = channels.find((c) => c.id === channelId && c.type !== 'voice')

  if (!channel) {
    return (
      <main className="chat">
        <ConnectionBanner />
        <div className="chat-empty">{t('chat.noChannel')}</div>
      </main>
    )
  }

  const partner = channel.type === 'dm' ? dmPartner(channel, myId) : null

  return (
    <DropZone channelId={channel.id}>
      <header className="chat-header">
        {partner ? (
          <>
            <Avatar id={partner.id} nickname={partner.nickname} size={26} online={partner.online} />
            <h3>{partner.nickname}</h3>
            {partner.status && <span className="chat-header-status">{partner.status}</span>}
          </>
        ) : (
          <>
            <HashIcon width={22} height={22} />
            <h3>{channel.name}</h3>
          </>
        )}
        <span className="chat-header-spacer" />
        <button className={searchOpen ? 'icon-btn active' : 'icon-btn'} title={t('chat.search')} onClick={() => openSearch(!searchOpen)}>
          <SearchIcon width={20} height={20} />
        </button>
      </header>
      <ConnectionBanner />
      <MessageList channel={channel} usersMap={usersMap} users={users} />
      <TypingIndicator channelId={channel.id} usersMap={usersMap} />
      <Composer key={channel.id} channel={channel} users={users} />
      {searchOpen && <SearchPanel channel={channel} />}
    </DropZone>
  )
}

/** Перетаскивание файлов в чат. */
function DropZone({ channelId, children }: { channelId: string; children: ReactNode }) {
  const { t } = useTranslation()
  const max = useApp((s) => s.maxUploadBytes)
  const [over, setOver] = useState(false)
  const depth = useRef(0)
  const hasFiles = (e: DragEvent): boolean => Array.from(e.dataTransfer.types).includes('Files')
  return (
    <main
      className="chat"
      onDragEnter={(e) => {
        if (!hasFiles(e)) return
        e.preventDefault()
        depth.current++
        setOver(true)
      }}
      onDragOver={(e) => {
        if (!hasFiles(e)) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'copy'
      }}
      onDragLeave={(e) => {
        if (!hasFiles(e)) return
        depth.current = Math.max(0, depth.current - 1)
        if (depth.current === 0) setOver(false)
      }}
      onDrop={(e) => {
        if (!hasFiles(e)) return
        e.preventDefault()
        depth.current = 0
        setOver(false)
        addFiles(channelId, Array.from(e.dataTransfer.files))
      }}
    >
      {children}
      {over && (
        <div className="drop-overlay">
          <div className="drop-box">
            <div className="drop-title">{t('files.dropHere')}</div>
            <div className="drop-hint">{t('files.dropHint', { max: formatSize(max) })}</div>
          </div>
        </div>
      )}
    </main>
  )
}

function ConnectionBanner() {
  const { t } = useTranslation()
  const status = useApp((s) => s.connStatus)
  const attempt = useApp((s) => s.reconnectAttempt)
  const notice = useApp((s) => s.connNotice)
  if (status === 'online' && !notice) return null
  if (status === 'online' && notice) return <div className="banner banner-warn">{notice}</div>
  return (
    <div className="banner banner-warn">
      {notice ? `${notice} · ` : ''}
      {t('conn.reconnecting', { attempt: Math.max(1, attempt) })}
    </div>
  )
}

function MessageList({ channel, usersMap, users }: { channel: Channel; usersMap: Record<string, UserInfo>; users: UserInfo[] }) {
  const { t } = useTranslation()
  const state = useApp((s) => s.messages[channel.id])
  const pending = useApp((s) => s.pending[channel.id]) ?? EMPTY_PENDING
  const me = useApp((s) => s.me)
  const editingId = useApp((s) => s.editingId)
  const newMark = useApp((s) => s.newMark[channel.id])
  const jump = useApp((s) => s.jump)
  const windowFocused = useApp((s) => s.windowFocused)
  const items = state?.items ?? EMPTY
  const ref = useRef<HTMLDivElement>(null)
  const atBottom = useRef(true)
  const lastHeight = useRef(0)
  const lastFirstId = useRef<number | null>(null)
  const lastChannel = useRef<string | null>(null)
  const lastJump = useRef<number>(0)
  const [highlight, setHighlight] = useState<number | null>(null)
  /** Черта «новые сообщения» ещё не показывалась на экране — кнопка «к непрочитанным» видна. */
  const [markSeen, setMarkSeen] = useState(false)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const firstId = items[0]?.id ?? null
    if (lastChannel.current !== channel.id) {
      el.scrollTop = el.scrollHeight
      atBottom.current = true
      setMarkSeen(false)
    } else if (firstId !== null && lastFirstId.current !== null && firstId < lastFirstId.current) {
      // Подгрузили старые сообщения сверху — сохраняем видимую позицию.
      el.scrollTop += el.scrollHeight - lastHeight.current
    } else if (atBottom.current) {
      el.scrollTop = el.scrollHeight
    }
    lastChannel.current = channel.id
    lastFirstId.current = firstId
    lastHeight.current = el.scrollHeight
  }, [items, pending, channel.id, editingId])

  // Прыжок к сообщению (ответ, поиск, непрочитанные): прокрутка и подсветка.
  useEffect(() => {
    if (!jump || jump.channelId !== channel.id || jump.nonce === lastJump.current) return
    lastJump.current = jump.nonce
    const el = ref.current?.querySelector<HTMLElement>(`.message[data-id="${jump.messageId}"]`)
    if (!el) return
    atBottom.current = false
    el.scrollIntoView({ block: 'center' })
    setHighlight(jump.messageId)
    const timer = setTimeout(() => setHighlight(null), 2500)
    return () => clearTimeout(timer)
  }, [jump, channel.id, items])

  // Если окно изменили в размере, а мы были внизу — остаёмся внизу.
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      if (atBottom.current) el.scrollTop = el.scrollHeight
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Новые сообщения в открытом канале прочитаны, пока окно в фокусе.
  useEffect(() => {
    if (windowFocused && items.length > 0) markChannelRead(channel.id)
  }, [items, windowFocused, channel.id])

  const onScroll = (): void => {
    const el = ref.current
    if (!el) return
    atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    lastHeight.current = el.scrollHeight
    if (el.scrollTop < 200 && state?.hasMore && !state.loading) void loadOlder(channel.id)
    if (newMark && !markSeen) {
      const mark = el.querySelector<HTMLElement>('.new-sep')
      if (mark) {
        const box = el.getBoundingClientRect()
        const r = mark.getBoundingClientRect()
        if (r.top >= box.top && r.bottom <= box.bottom) setMarkSeen(true)
      }
    }
  }

  const firstUnreadId = newMark?.firstUnreadId ?? null
  const markLoaded = firstUnreadId !== null && items.some((m) => m.id >= firstUnreadId)
  const rows = items.map((m, i) => {
    const prev = items[i - 1]
    const newDay = !prev || dayKey(prev.createdAt) !== dayKey(m.createdAt)
    const isFirstNew = firstUnreadId !== null && m.id >= firstUnreadId && (!prev || prev.id < firstUnreadId)
    const grouped =
      !newDay && !isFirstNew && prev.authorId === m.authorId && m.createdAt - prev.createdAt < TIMINGS.messageGroupWindowMs
    return (
      <Fragment key={m.id}>
        {newDay && (
          <div className="day-sep">
            <span>{formatDay(m.createdAt)}</span>
          </div>
        )}
        {isFirstNew && (
          <div className="new-sep">
            <span>{t('chat.newMessages')}</span>
          </div>
        )}
        <div className={highlight === m.id ? 'message-highlight' : undefined}>
          <MessageItem
            message={m}
            grouped={grouped}
            author={usersMap[m.authorId]}
            users={users}
            myId={me?.id}
            canDelete={m.authorId === me?.id || (Boolean(me?.isAdmin) && channel.type !== 'dm')}
            editing={editingId === m.id}
            dm={channel.type === 'dm'}
          />
        </div>
      </Fragment>
    )
  })

  const showUnreadBar = newMark && !markSeen && newMark.count > 0

  return (
    <div className="messages-wrap">
      {showUnreadBar && (
        <button
          className="unread-bar"
          onClick={() => {
            if (firstUnreadId !== null) void jumpToMessage(channel.id, firstUnreadId)
            setMarkSeen(true)
          }}
        >
          <ArrowDownIcon width={14} height={14} className="rot180" />
          {t('chat.unreadBar', { count: newMark.count })}
          <span
            className="unread-bar-dismiss"
            onClick={(e) => {
              e.stopPropagation()
              dismissNewMark(channel.id)
            }}
          >
            {t('chat.unreadDismiss')}
          </span>
        </button>
      )}
      <div className="messages" ref={ref} onScroll={onScroll}>
        {state?.loaded && !state.hasMore && (
          <div className="channel-welcome">
            <div className="channel-welcome-icon">{channel.type === 'dm' ? <ChatIcon width={36} height={36} /> : <HashIcon width={36} height={36} />}</div>
            <h2>{channel.type === 'dm' ? t('chat.dmWelcomeTitle', { name: dmPartner(channel, me?.id)?.nickname ?? '' }) : t('chat.welcomeTitle', { channel: channel.name })}</h2>
            <p>{channel.type === 'dm' ? t('chat.dmWelcomeText') : t('chat.welcomeText')}</p>
          </div>
        )}
        {state?.loading && <div className="loading-older">{t('chat.loadingOlder')}</div>}
        {!markLoaded && firstUnreadId !== null && state?.loaded && (
          <div className="new-sep muted">
            <span>{t('chat.newMessagesAbove')}</span>
          </div>
        )}
        {rows}
        {pending.map((p) => (
          <div key={p.nonce} className={p.failed ? 'message pending failed' : 'message pending'}>
            <div className="message-gutter">{me && <Avatar id={me.id} nickname={me.nickname} size={40} />}</div>
            <div className="message-main">
              {p.replyTo && (
                <ReplyQuote
                  reply={{
                    id: p.replyTo.id,
                    authorId: p.replyTo.authorId,
                    authorName: p.replyTo.authorName,
                    content: p.replyTo.content,
                    attachments: p.replyTo.attachments.length,
                    deleted: false
                  }}
                  channelId={channel.id}
                  users={usersMap}
                />
              )}
              <div className="message-head">
                <span className="message-author">{me?.nickname}</span>
                <span className="message-time">{p.failed ? t('chat.failed') : t('chat.sending')}</span>
              </div>
              {p.content && <div className="message-body">{p.content}</div>}
              <Attachments files={p.attachments} />
            </div>
            {p.failed && (
              <div className="message-actions visible">
                <button className="icon-btn" title={t('common.retry')} onClick={() => retryPending(channel.id, p.nonce)}>
                  <RetryIcon width={16} height={16} />
                </button>
                <button className="icon-btn danger" title={t('common.delete')} onClick={() => discardPending(channel.id, p.nonce)}>
                  <TrashIcon width={16} height={16} />
                </button>
              </div>
            )}
          </div>
        ))}
        <div className="messages-end" />
      </div>
    </div>
  )
}

function TypingIndicator({ channelId, usersMap }: { channelId: string; usersMap: Record<string, UserInfo> }) {
  const { t } = useTranslation()
  const typing = useApp((s) => s.typing[channelId])
  const myId = useApp((s) => s.me?.id)
  const [now, setNow] = useState(Date.now())

  useEffect(() => {
    if (!typing || Object.keys(typing).length === 0) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [typing])

  const names = Object.entries(typing ?? {})
    .filter(([id, until]) => until > now && id !== myId)
    .map(([id]) => usersMap[id]?.nickname ?? '…')

  let text = ''
  if (names.length === 1) text = t('chat.typingOne', { a: names[0] })
  else if (names.length === 2) text = t('chat.typingTwo', { a: names[0], b: names[1] })
  else if (names.length > 2) text = t('chat.typingMany')

  return (
    <div className="typing">
      {text && (
        <>
          <span className="typing-dots">
            <i />
            <i />
            <i />
          </span>
          {text}
        </>
      )}
    </div>
  )
}
