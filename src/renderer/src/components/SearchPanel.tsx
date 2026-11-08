import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import type { Channel, Message } from '../../../shared/types'
import { formatFull } from '../lib/format'
import { useApp } from '../store/app'
import { dmPartner, jumpToMessage, loadMoreSearch, openSearch, runSearch, setSearchScope } from '../store/session'
import { Avatar } from './Common'
import { CloseIcon, SearchIcon } from './Icons'

/** Панель поиска по сообщениям (открывается кнопкой в шапке чата). */
export function SearchPanel({ channel }: { channel: Channel }) {
  const { t } = useTranslation()
  const search = useApp((s) => s.search)
  const channels = useApp((s) => s.channels)
  const users = useApp((s) => s.users)
  const myId = useApp((s) => s.me?.id)
  const input = useRef<HTMLInputElement>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    input.current?.focus()
    return () => {
      if (timer.current) clearTimeout(timer.current)
    }
  }, [])

  const onChange = (value: string): void => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => void runSearch(value), 300)
  }

  const channelName = (m: Message): string => {
    const ch = channels.find((c) => c.id === m.channelId)
    if (!ch) return ''
    if (ch.type === 'dm') return t('chat.dmWith', { name: dmPartner(ch, myId)?.nickname ?? '?' })
    return `#${ch.name}`
  }

  const scopeName = channel.type === 'dm' ? t('chat.dmWith', { name: dmPartner(channel, myId)?.nickname ?? '?' }) : `#${channel.name}`

  return (
    <aside className="search-panel">
      <div className="search-head">
        <SearchIcon width={18} height={18} />
        <input
          ref={input}
          defaultValue={search.query}
          placeholder={t('chat.searchPlaceholder')}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') openSearch(false)
            if (e.key === 'Enter') void runSearch(e.currentTarget.value)
          }}
        />
        <button className="icon-btn" title={t('common.close')} onClick={() => openSearch(false)}>
          <CloseIcon width={18} height={18} />
        </button>
      </div>
      <label className="checkbox search-scope">
        <input type="checkbox" checked={search.currentOnly} onChange={(e) => setSearchScope(e.target.checked)} />
        {t('chat.searchHere', { channel: scopeName })}
      </label>
      <div className="search-results">
        {search.error && <div className="error-box">{search.error}</div>}
        {!search.loading && search.query.trim() && search.results.length === 0 && !search.error && (
          <p className="hint">{t('chat.searchNothing')}</p>
        )}
        {search.results.map((m) => {
          const author = users[m.authorId]
          return (
            <button key={m.id} className="search-result" onClick={() => void jumpToMessage(m.channelId, m.id)}>
              <div className="search-result-head">
                <Avatar id={m.authorId} nickname={author?.nickname ?? m.authorName} size={20} />
                <span className="search-result-author">{author?.nickname ?? m.authorName}</span>
                <span className="search-result-where">{channelName(m)}</span>
                <span className="search-result-time">{formatFull(m.createdAt)}</span>
              </div>
              <div className="search-result-text">
                {m.content || (m.attachments.length ? t('chat.replyAttachment', { count: m.attachments.length }) : '')}
              </div>
            </button>
          )
        })}
        {search.hasMore && (
          <button className="btn btn-small btn-secondary search-more" disabled={search.loading} onClick={() => void loadMoreSearch()}>
            {t('chat.searchMore')}
          </button>
        )}
        {search.loading && <p className="hint">{t('common.loading')}</p>}
      </div>
    </aside>
  )
}
