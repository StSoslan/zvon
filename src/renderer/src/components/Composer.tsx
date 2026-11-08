import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { LIMITS } from '../../../shared/constants'
import type { Channel, UserInfo } from '../../../shared/types'
import { formatSize } from '../lib/files'
import { getApp, setApp, useApp, type DraftAttachment } from '../store/app'
import { dmPartner, notifyTyping, sendMessage, setReplyTo } from '../store/session'
import { addFiles, draftsBusy, removeDraft, retryDraft, takeReadyAttachments } from '../store/uploads'
import { Avatar } from './Common'
import { EmojiPicker } from './EmojiPicker'
import { CloseIcon, FileIcon, PlusCircleIcon, ReplyIcon, RetryIcon, SendIcon, SmileIcon } from './Icons'

const NO_DRAFTS: DraftAttachment[] = []

/** На телефоне поле ввода не берёт фокус само: иначе клавиатура выезжает при каждой смене канала. */
const TOUCH = typeof window !== 'undefined' && window.matchMedia('(hover: none)').matches

/** Черновики по каналам живут, пока открыто приложение. */
const drafts = new Map<string, string>()

interface MentionState {
  start: number
  query: string
  index: number
}

function findMention(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret)
  const m = /(^|\s)@([^\s@]{0,32})$/u.exec(before)
  if (!m) return null
  return { start: caret - m[2].length - 1, query: m[2] }
}

export function Composer({ channel, users }: { channel: Channel; users: UserInfo[] }) {
  const { t } = useTranslation()
  const [text, setText] = useState(() => drafts.get(channel.id) ?? '')
  const [mention, setMention] = useState<MentionState | null>(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const attachments = useApp((s) => s.drafts[channel.id]) ?? NO_DRAFTS
  const replyTo = useApp((s) => s.replyTo[channel.id] ?? null)
  const usersMap = useApp((s) => s.users)
  const myId = useApp((s) => s.me?.id)
  const ref = useRef<HTMLTextAreaElement>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  /** Куда поставить курсор после программной вставки (применяется сразу после рендера). */
  const pendingCaret = useRef<number | null>(null)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el || pendingCaret.current === null) return
    const pos = pendingCaret.current
    pendingCaret.current = null
    el.focus()
    el.setSelectionRange(pos, pos)
  }, [text])

  // Смена канала — подставляем его черновик.
  useEffect(() => {
    setText(drafts.get(channel.id) ?? '')
    setMention(null)
    if (!TOUCH) ref.current?.focus()
  }, [channel.id])

  // Нажали «Ответить» — курсор в поле ввода.
  useEffect(() => {
    if (replyTo) ref.current?.focus()
  }, [replyTo])

  useEffect(() => {
    drafts.set(channel.id, text)
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`
  }, [text, channel.id])

  // Глобально: начали печатать где угодно — фокус в поле ввода.
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent): void => {
      const target = e.target as HTMLElement | null
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return
      if (e.ctrlKey || e.metaKey || e.altKey || e.key.length !== 1) return
      if (document.querySelector('.modal-backdrop')) return
      ref.current?.focus()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const suggestions = useMemo(() => {
    if (!mention) return []
    const q = mention.query.toLowerCase()
    const list: Array<{ id: string; nickname: string; user?: UserInfo }> = users
      .filter((u) => u.nickname.toLowerCase().includes(q))
      .sort((a, b) => {
        const as = a.nickname.toLowerCase().startsWith(q) ? 0 : 1
        const bs = b.nickname.toLowerCase().startsWith(q) ? 0 : 1
        return as - bs || Number(b.online) - Number(a.online) || a.nickname.localeCompare(b.nickname)
      })
      .slice(0, 8)
      .map((u) => ({ id: u.id, nickname: u.nickname, user: u }))
    if ('everyone'.startsWith(q) || 'все'.startsWith(q)) list.push({ id: 'everyone', nickname: 'everyone' })
    return list
  }, [mention, users])

  const updateMention = (value: string, caret: number): void => {
    const found = findMention(value, caret)
    setMention(found ? { ...found, index: 0 } : null)
  }

  const insertAtCaret = (insert: string, replaceFrom?: number): void => {
    const el = ref.current
    const caret = el?.selectionStart ?? text.length
    const from = replaceFrom ?? caret
    const next = text.slice(0, from) + insert + text.slice(caret)
    if (next.length > LIMITS.messageLength) return
    pendingCaret.current = from + insert.length
    setText(next)
  }

  const applyMention = (nickname: string): void => {
    if (!mention) return
    insertAtCaret(`@${nickname} `, mention.start)
    setMention(null)
  }

  const busy = attachments.some((d) => d.status === 'preparing' || d.status === 'uploading')
  const ready = attachments.some((d) => d.status === 'done')
  const canSend = (text.trim().length > 0 || ready) && !busy && text.length <= LIMITS.messageLength

  const attach = (list: File[]): void => {
    if (list.length === 0) return
    setNotice(addFiles(channel.id, list))
    ref.current?.focus()
  }

  const submit = (): void => {
    if (draftsBusy(channel.id)) {
      setNotice(t('files.waitUploads'))
      return
    }
    if (!canSend) return
    sendMessage(channel.id, text, takeReadyAttachments(channel.id))
    setText('')
    setMention(null)
    setNotice(null)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (mention && suggestions.length > 0) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        const delta = e.key === 'ArrowDown' ? 1 : -1
        setMention({ ...mention, index: (mention.index + delta + suggestions.length) % suggestions.length })
        return
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        applyMention(suggestions[mention.index]?.nickname ?? suggestions[0].nickname)
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setMention(null)
        return
      }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      submit()
      return
    }
    if (e.key === 'Escape' && replyTo) {
      e.preventDefault()
      setReplyTo(channel.id, null)
      return
    }
    // Стрелка вверх в пустом поле — редактировать своё последнее сообщение.
    if (e.key === 'ArrowUp' && !text) {
      const s = getApp()
      const items = s.messages[channel.id]?.items ?? []
      const last = [...items].reverse().find((m) => m.authorId === s.me?.id)
      if (last) {
        e.preventDefault()
        setApp({ editingId: last.id })
      }
    }
  }

  const tooLong = text.length > LIMITS.messageLength - 200
  const placeholder = channel.type === 'dm' ? t('chat.placeholderDm', { name: dmPartner(channel, myId)?.nickname ?? '' }) : t('chat.placeholder', { channel: channel.name })

  return (
    <div className="composer">
      {replyTo && (
        <div className="reply-bar">
          <ReplyIcon width={16} height={16} />
          <span className="reply-bar-text">
            {t('chat.replyingTo')} <b>{usersMap[replyTo.authorId]?.nickname ?? replyTo.authorName}</b>
            {replyTo.content ? <span className="reply-bar-snippet">: {replyTo.content.replace(/\s+/gu, ' ').slice(0, 120)}</span> : null}
          </span>
          <button className="icon-btn" title={t('common.cancel')} onClick={() => setReplyTo(channel.id, null)}>
            <CloseIcon width={16} height={16} />
          </button>
        </div>
      )}
      {attachments.length > 0 && (
        <div className="drafts">
          {attachments.map((d) => (
            <DraftChip key={d.localId} draft={d} channelId={channel.id} />
          ))}
        </div>
      )}
      {mention && suggestions.length > 0 && (
        <div className="mention-popup">
          {suggestions.map((s, i) => (
            <button
              key={s.id}
              className={i === mention.index ? 'mention-option active' : 'mention-option'}
              onMouseDown={(e) => {
                e.preventDefault()
                applyMention(s.nickname)
              }}
            >
              {s.user ? <Avatar id={s.user.id} nickname={s.user.nickname} size={24} online={s.user.online} /> : <span className="at">@</span>}
              <span>{s.nickname}</span>
            </button>
          ))}
        </div>
      )}
      <div className="composer-box">
        <button className="icon-btn attach-btn" title={t('files.attach')} onClick={() => fileInput.current?.click()}>
          <PlusCircleIcon width={22} height={22} />
        </button>
        <input
          ref={fileInput}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            attach(Array.from(e.target.files ?? []))
            e.target.value = ''
          }}
        />
        <textarea
          ref={ref}
          value={text}
          rows={1}
          maxLength={LIMITS.messageLength}
          placeholder={placeholder}
          onChange={(e) => {
            setText(e.target.value)
            updateMention(e.target.value, e.target.selectionStart ?? e.target.value.length)
            if (e.target.value.trim()) notifyTyping(channel.id)
          }}
          onKeyDown={onKeyDown}
          onClick={(e) => updateMention(text, e.currentTarget.selectionStart ?? text.length)}
          onBlur={() => setTimeout(() => setMention(null), 150)}
          onPaste={(e) => {
            // Скриншот или файл из буфера обмена — во вложения; обычный текст вставляется как есть.
            const pasted = Array.from(e.clipboardData.files)
            if (pasted.length > 0) {
              e.preventDefault()
              attach(pasted)
            }
          }}
        />
        <button className="icon-btn" title={t('chat.emoji')} onClick={() => setPickerOpen((v) => !v)}>
          <SmileIcon width={22} height={22} />
        </button>
        <button className="icon-btn send" title={busy ? t('files.waitUploads') : t('chat.send')} disabled={!canSend} onClick={submit}>
          <SendIcon width={20} height={20} />
        </button>
        {pickerOpen && (
          <EmojiPicker
            onClose={() => setPickerOpen(false)}
            onPick={(emoji, keepOpen) => {
              insertAtCaret(emoji)
              if (!keepOpen) setPickerOpen(false)
            }}
          />
        )}
      </div>
      {notice && <div className="counter over">{notice}</div>}
      {tooLong && (
        <div className={text.length > LIMITS.messageLength ? 'counter over' : 'counter'}>
          {t('chat.tooLong', { len: text.length, max: LIMITS.messageLength })}
        </div>
      )}
    </div>
  )
}

function DraftChip({ draft, channelId }: { draft: DraftAttachment; channelId: string }) {
  const { t } = useTranslation()
  const percent = Math.round(draft.progress * 100)
  const maxBytes = useApp((s) => s.maxUploadBytes)
  const retryable = draft.status === 'error' && (maxBytes === 0 || draft.size <= maxBytes)
  return (
    <div className={`draft ${draft.status}`} title={draft.error ?? draft.name}>
      <div className="draft-preview">
        {draft.kind === 'image' && draft.previewUrl ? (
          <img src={draft.previewUrl} alt="" draggable={false} />
        ) : draft.kind === 'video' && draft.previewUrl ? (
          <video src={draft.previewUrl} muted preload="metadata" />
        ) : (
          <FileIcon width={36} height={36} />
        )}
        {(draft.status === 'uploading' || draft.status === 'preparing') && (
          <div className="draft-progress">
            <div style={{ width: `${percent}%` }} />
          </div>
        )}
      </div>
      <div className="draft-name">{draft.name}</div>
      <div className="draft-status">
        {draft.status === 'preparing'
          ? t('files.preparing')
          : draft.status === 'uploading'
            ? t('files.uploading', { percent })
            : draft.status === 'error'
              ? draft.error
              : formatSize(draft.size)}
      </div>
      <div className="draft-actions">
        {retryable && (
          <button className="icon-btn" title={t('files.retry')} onClick={() => retryDraft(channelId, draft.localId)}>
            <RetryIcon width={14} height={14} />
          </button>
        )}
        <button className="icon-btn danger" title={t('files.remove')} onClick={() => removeDraft(channelId, draft.localId)}>
          <CloseIcon width={14} height={14} />
        </button>
      </div>
    </div>
  )
}
