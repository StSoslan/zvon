import { memo, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { LIMITS } from '../../../shared/constants'
import type { Message, ReplyRef, Role, UserInfo } from '../../../shared/types'
import { renderContent } from '../lib/content'
import { isEmojiOnly } from '../lib/emoji'
import { formatFull, formatTime } from '../lib/format'
import { setApp, useApp } from '../store/app'
import { deleteMessage, editMessage, isMentioned, jumpToMessage, setReplyTo } from '../store/session'
import { Attachments } from './Attachments'
import { Avatar } from './Common'
import { EditIcon, ReplyIcon, TrashIcon } from './Icons'

interface Props {
  message: Message
  grouped: boolean
  author: UserInfo | undefined
  users: UserInfo[]
  myId: string | undefined
  canDelete: boolean
  editing: boolean
  /** Сообщение из личной переписки: упоминанием не подсвечивается. */
  dm?: boolean
}

/** Цвет ника по старшей роли участника. */
export function roleColor(user: UserInfo | undefined, roles: Role[]): string | undefined {
  if (!user?.roles.length) return undefined
  const top = roles.find((r) => user.roles.includes(r.id))
  return top?.color
}

/** Метки ролей рядом с именем. */
export function RoleTags({ user, roles }: { user: UserInfo | undefined; roles: Role[] }) {
  if (!user?.roles.length) return null
  return (
    <>
      {roles
        .filter((r) => user.roles.includes(r.id))
        .map((r) => (
          <span key={r.id} className="tag tag-role" style={{ borderColor: r.color, color: r.color }}>
            {r.name}
          </span>
        ))}
    </>
  )
}

/** Цитата сообщения, на которое ответили. Нажатие ведёт к исходному сообщению. */
export function ReplyQuote({ reply, channelId, users }: { reply: ReplyRef; channelId: string; users: Record<string, UserInfo> }) {
  const { t } = useTranslation()
  const name = reply.deleted ? '' : (users[reply.authorId]?.nickname ?? reply.authorName)
  return (
    <button
      className="reply-quote"
      disabled={reply.deleted}
      onClick={() => void jumpToMessage(channelId, reply.id)}
      title={reply.deleted ? undefined : t('chat.goToMessage')}
    >
      <ReplyIcon width={14} height={14} />
      {reply.deleted ? (
        <span className="reply-deleted">{t('chat.replyDeleted')}</span>
      ) : (
        <>
          <span className="reply-author">{name}</span>
          <span className="reply-text">{reply.content || (reply.attachments > 0 ? t('chat.replyAttachment', { count: reply.attachments }) : '')}</span>
        </>
      )}
    </button>
  )
}

/** Сенсорный экран: наведения нет, кнопки действий показываются по нажатию на сообщение. */
const TOUCH = typeof window !== 'undefined' && window.matchMedia('(hover: none)').matches

export const MessageItem = memo(function MessageItem({ message, grouped, author, users, myId, canDelete, editing, dm }: Props) {
  const { t } = useTranslation()
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState(false)
  const roles = useApp((s) => s.roles)
  const usersMap = useApp((s) => s.users)
  const mine = message.authorId === myId
  const name = author?.nickname ?? message.authorName
  const mentioned = !dm && isMentioned(message, myId)
  const big = isEmojiOnly(message.content)
  const color = roleColor(author, roles)

  const onDelete = async (skipConfirm: boolean): Promise<void> => {
    if (!skipConfirm && !window.confirm(t('chat.deleteConfirm'))) return
    const err = await deleteMessage(message.id, message.channelId)
    if (err) setError(err)
  }

  const showHead = !grouped || message.replyTo !== null
  const cls = ['message', grouped && !message.replyTo ? 'grouped' : '', mentioned ? 'mentioned' : '', editing ? 'editing' : '', selected ? 'selected' : ''].join(' ')

  return (
    <div
      className={cls}
      data-id={message.id}
      onClick={(e) => {
        if (!TOUCH) return
        // Нажатие по ссылке, кнопке или вложению — не переключает действия.
        const target = e.target as HTMLElement
        if (target.closest('a, button, video, audio, img, textarea, input')) return
        setSelected((v) => !v)
      }}
    >
      <div className="message-gutter">
        {showHead ? (
          <Avatar id={message.authorId} nickname={name} size={40} />
        ) : (
          <span className="message-time-hover" title={formatFull(message.createdAt)}>
            {formatTime(message.createdAt)}
          </span>
        )}
      </div>
      <div className="message-main">
        {message.replyTo && <ReplyQuote reply={message.replyTo} channelId={message.channelId} users={usersMap} />}
        {showHead && (
          <div className="message-head">
            <span className="message-author" style={color ? { color } : undefined}>
              {name}
            </span>
            {author?.isAdmin && <span className="tag">{t('members.admin')}</span>}
            <RoleTags user={author} roles={roles} />
            <span className="message-time" title={formatFull(message.createdAt)}>
              {formatTime(message.createdAt)}
            </span>
          </div>
        )}
        {editing ? (
          <EditBox message={message} onError={setError} />
        ) : (
          message.content.trim() !== '' && (
            <div className={big ? 'message-body emoji-big' : 'message-body'}>
              {renderContent(message.content, users, myId)}
              {message.editedAt && (
                <span className="edited" title={formatFull(message.editedAt)}>
                  {' '}
                  {t('chat.edited')}
                </span>
              )}
            </div>
          )
        )}
        <Attachments files={message.attachments} />
        {error && <div className="message-error">{error}</div>}
      </div>
      {!editing && (
        <div className="message-actions">
          <button
            className="icon-btn"
            title={t('chat.reply')}
            onClick={() => {
              setSelected(false)
              setReplyTo(message.channelId, message)
            }}
          >
            <ReplyIcon width={16} height={16} />
          </button>
          {mine && (
            <button className="icon-btn" title={t('chat.edit')} onClick={() => setApp({ editingId: message.id })}>
              <EditIcon width={16} height={16} />
            </button>
          )}
          {(mine || canDelete) && (
            <button className="icon-btn danger" title={t('common.delete')} onClick={(e) => void onDelete(e.shiftKey)}>
              <TrashIcon width={16} height={16} />
            </button>
          )}
        </div>
      )}
    </div>
  )
})

function EditBox({ message, onError }: { message: Message; onError: (e: string | null) => void }) {
  const { t } = useTranslation()
  const [value, setValue] = useState(message.content)
  const [busy, setBusy] = useState(false)
  const ref = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.focus()
    el.setSelectionRange(el.value.length, el.value.length)
  }, [])

  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 300)}px`
  }, [value])

  const save = async (): Promise<void> => {
    const v = value.trim()
    if (v === message.content.trim()) {
      setApp({ editingId: null })
      return
    }
    if (!v && message.attachments.length > 0) {
      // Текст убрать нельзя, если остаются файлы, — просто выходим из редактирования.
      setApp({ editingId: null })
      return
    }
    if (!v) {
      // Пустое сообщение при редактировании = удаление (как в Discord).
      const err = await deleteMessage(message.id, message.channelId)
      if (err) onError(err)
      setApp({ editingId: null })
      return
    }
    setBusy(true)
    const err = await editMessage(message.id, v)
    setBusy(false)
    onError(err)
  }

  return (
    <div className="edit-box">
      <textarea
        ref={ref}
        value={value}
        maxLength={LIMITS.messageLength}
        disabled={busy}
        rows={1}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault()
            setApp({ editingId: null })
          } else if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            void save()
          }
        }}
      />
      <div className="hint">{t('chat.editHint')}</div>
    </div>
  )
}
