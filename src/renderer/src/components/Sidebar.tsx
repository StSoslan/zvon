import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { LIMITS } from '../../../shared/constants'
import { useApp } from '../store/app'
import { makeAvatar } from '../lib/files'
import { changePassword, disconnect, dmPartner, selectChannel, setMyStatus, updateProfile } from '../store/session'
import { Avatar, Modal } from './Common'
import { HostPanel } from './HostPanel'
import { HostShare } from './HostShare'
import { AtIcon, ChevronIcon, CloseIcon, EditIcon, HashIcon, LogoutIcon, ServerIcon, UserPlusIcon } from './Icons'
import { VoiceChannelItem, VoiceControls, VoicePanel } from './Voice'

export function Sidebar() {
  return (
    <aside className="sidebar">
      <ServerHeader />
      <ChannelList />
      <VoicePanel />
      <UserPanel />
    </aside>
  )
}

function ServerHeader() {
  const { t } = useTranslation()
  const serverName = useApp((s) => s.serverName)
  const isOwnServer = useApp((s) => s.isOwnServer)
  const isAdmin = useApp((s) => Boolean(s.me?.isAdmin))
  const [menuOpen, setMenuOpen] = useState(false)
  const [inviteOpen, setInviteOpen] = useState(false)
  const [panelOpen, setPanelOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!menuOpen) return
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setMenuOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [menuOpen])

  return (
    <div className="server-header" ref={ref}>
      <button className="server-header-btn" onClick={() => setMenuOpen((v) => !v)}>
        <span className="server-name">{serverName}</span>
        <ChevronIcon width={18} height={18} className={menuOpen ? 'rot180' : ''} />
      </button>
      {menuOpen && (
        <div className="dropdown">
          {isAdmin && (
            <button
              className="dropdown-item"
              onClick={() => {
                setMenuOpen(false)
                setPanelOpen(true)
              }}
            >
              <ServerIcon width={16} height={16} />
              {t('admin.title')}
            </button>
          )}
          {isOwnServer && (
            <button
              className="dropdown-item accent"
              onClick={() => {
                setMenuOpen(false)
                setInviteOpen(true)
              }}
            >
              <UserPlusIcon width={16} height={16} />
              {t('server.invite')}
            </button>
          )}
          <button
            className="dropdown-item danger"
            onClick={() => {
              setMenuOpen(false)
              disconnect()
            }}
          >
            <LogoutIcon width={16} height={16} />
            {t('server.disconnect')}
          </button>
        </div>
      )}
      {inviteOpen && <InviteDialog onClose={() => setInviteOpen(false)} />}
      {panelOpen && <HostPanel onClose={() => setPanelOpen(false)} />}
    </div>
  )
}

function InviteDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation()
  const status = useApp((s) => s.hostStatus)
  return (
    <Modal title={t('server.invite')} onClose={onClose}>
      <HostShare status={status} />
    </Modal>
  )
}

function ChannelList() {
  const { t } = useTranslation()
  const channels = useApp((s) => s.channels)
  const current = useApp((s) => s.currentChannelId)
  const unread = useApp((s) => s.unread)
  const myId = useApp((s) => s.me?.id)
  const users = useApp((s) => s.users)
  const text = channels.filter((c) => c.type === 'text')
  const voice = channels.filter((c) => c.type === 'voice')
  const dms = channels.filter((c) => c.type === 'dm')

  return (
    <nav className="channel-list">
      <div className="channel-group">{t('chat.textChannels')}</div>
      {text.map((c) => {
        const u = unread[c.id]
        const cls = ['channel', c.id === current ? 'active' : '', u ? 'unread' : ''].join(' ')
        return (
          <button key={c.id} className={cls} onClick={() => selectChannel(c.id)}>
            <HashIcon width={18} height={18} />
            <span className="channel-name">{c.name}</span>
            {u && u.mentions > 0 && <span className="badge">{u.mentions}</span>}
          </button>
        )
      })}
      {voice.length > 0 && <div className="channel-group">{t('chat.voiceChannels')}</div>}
      {voice.map((c) => (
        <VoiceChannelItem key={c.id} channel={c} />
      ))}
      {dms.length > 0 && <div className="channel-group">{t('chat.directMessages')}</div>}
      {dms.map((c) => {
        const partner = dmPartner(c, myId)
        const u = unread[c.id]
        const cls = ['channel channel-dm', c.id === current ? 'active' : '', u ? 'unread' : ''].join(' ')
        const name = partner ? (users[partner.id]?.nickname ?? partner.nickname) : '?'
        return (
          <button key={c.id} className={cls} onClick={() => selectChannel(c.id)} title={partner?.status ?? undefined}>
            {partner && <Avatar id={partner.id} nickname={name} size={22} online={partner.online} />}
            <span className="channel-name">{name}</span>
            {u && u.count > 0 && <span className="badge">{u.count}</span>}
          </button>
        )
      })}
    </nav>
  )
}

function UserPanel() {
  const { t } = useTranslation()
  const me = useApp((s) => s.me)
  const connStatus = useApp((s) => s.connStatus)
  const [editOpen, setEditOpen] = useState(false)
  const [statusOpen, setStatusOpen] = useState(false)
  if (!me) return null
  return (
    <div className="user-panel">
      <div className="user-panel-me">
        <button className="user-panel-avatar" title={t('profile.title')} onClick={() => setEditOpen(true)}>
          <Avatar id={me.id} nickname={me.nickname} size={32} online={connStatus === 'online'} />
        </button>
        <span className="user-panel-name">
          <button className="name" title={t('profile.title')} onClick={() => setEditOpen(true)}>
            {me.nickname}
            <EditIcon width={11} height={11} className="edit-hint" />
          </button>
          <button className={me.status ? 'status has-status' : 'status'} title={t('status.set')} onClick={() => setStatusOpen((v) => !v)}>
            {me.status ?? (connStatus === 'online' ? t('status.none') : connStatus)}
          </button>
        </span>
        {statusOpen && <StatusMenu current={me.status} onClose={() => setStatusOpen(false)} />}
      </div>
      <VoiceControls />
      {editOpen && <ProfileDialog current={me.nickname} onClose={() => setEditOpen(false)} />}
    </div>
  )
}

/** Выбор статуса: готовые варианты сервера или свой текст. */
function StatusMenu({ current, onClose }: { current: string | null; onClose: () => void }) {
  const { t } = useTranslation()
  const presets = useApp((s) => s.statusPresets)
  const [text, setText] = useState(current ?? '')
  const [error, setError] = useState<string | null>(null)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  const apply = async (value: string | null): Promise<void> => {
    const err = await setMyStatus(value)
    if (err) setError(err)
    else onClose()
  }

  return (
    <div className="status-menu" ref={ref}>
      <div className="status-menu-title">
        <AtIcon width={16} height={16} />
        {t('status.set')}
      </div>
      {presets.map((p) => (
        <button key={p} className={p === current ? 'dropdown-item active' : 'dropdown-item'} onClick={() => void apply(p)}>
          {p}
        </button>
      ))}
      <form
        className="status-custom"
        onSubmit={(e) => {
          e.preventDefault()
          void apply(text.trim() || null)
        }}
      >
        <input
          autoFocus
          value={text}
          maxLength={LIMITS.statusLength}
          placeholder={t('status.customPlaceholder')}
          onChange={(e) => setText(e.target.value)}
        />
        <button className="btn btn-small btn-primary" type="submit">
          {t('common.save')}
        </button>
      </form>
      {current && (
        <button className="dropdown-item danger" onClick={() => void apply(null)}>
          <CloseIcon width={14} height={14} />
          {t('status.clear')}
        </button>
      )}
      {error && <div className="error-box">{error}</div>}
    </div>
  )
}

function ProfileDialog({ current, onClose }: { current: string; onClose: () => void }) {
  const { t } = useTranslation()
  const account = useApp((s) => s.account)
  const me = useApp((s) => s.me)
  const [value, setValue] = useState(current)
  const [avatar, setAvatar] = useState<{ blob: Blob; dataUrl: string } | null | undefined>(undefined)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const input = useRef<HTMLInputElement>(null)

  const pick = async (file: File | undefined): Promise<void> => {
    if (!file) return
    try {
      setAvatar(await makeAvatar(file))
      setError(null)
    } catch {
      setError(t('files.imageError'))
    }
  }

  const save = async (): Promise<void> => {
    const v = value.trim()
    if (!v) return
    if (v === current && avatar === undefined) {
      onClose()
      return
    }
    setBusy(true)
    const err = await updateProfile(v, avatar)
    setBusy(false)
    if (err) setError(err)
    else onClose()
  }

  const hasAvatar = avatar ? true : avatar === null ? false : Boolean(me?.avatar)

  return (
    <Modal
      title={t('profile.title')}
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-secondary" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button className="btn btn-primary" disabled={busy || !value.trim()} onClick={() => void save()}>
            {t('common.save')}
          </button>
        </>
      }
    >
      <div className="profile-avatar">
        {avatar ? (
          <img className="profile-preview" src={avatar.dataUrl} alt="" />
        ) : avatar === null || !me ? (
          <div className="profile-preview empty">{value.slice(0, 1).toUpperCase() || '?'}</div>
        ) : (
          <Avatar id={me.id} nickname={me.nickname} size={96} />
        )}
        <div className="profile-avatar-actions">
          <span className="field-label">{t('profile.avatar')}</span>
          <div className="button-row">
            <button className="btn btn-small btn-secondary" onClick={() => input.current?.click()}>
              {t('profile.change')}
            </button>
            {hasAvatar && (
              <button className="btn btn-small btn-secondary" onClick={() => setAvatar(null)}>
                {t('profile.remove')}
              </button>
            )}
          </div>
          <p className="hint">{t(account ? 'profile.hintAccount' : 'profile.hint')}</p>
          <input
            ref={input}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            hidden
            onChange={(e) => {
              void pick(e.target.files?.[0])
              e.target.value = ''
            }}
          />
        </div>
      </div>
      <label className="field">
        <span className="field-label">{t('user.newNickname')}</span>
        <input
          autoFocus
          value={value}
          maxLength={LIMITS.nicknameLength}
          onChange={(e) => setValue(e.target.value.replace(/@/g, ''))}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void save()
          }}
        />
      </label>
      {error && <div className="error-box">{error}</div>}
      <PasswordSection />
    </Modal>
  )
}

/** Смена пароля (только на сервере с аккаунтами). */
function PasswordSection() {
  const { t } = useTranslation()
  const account = useApp((s) => s.account)
  const [open, setOpen] = useState(false)
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [repeat, setRepeat] = useState('')
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [busy, setBusy] = useState(false)
  if (!account) return null

  const submit = async (): Promise<void> => {
    if (next.length < LIMITS.accountPasswordMin) return setMsg({ ok: false, text: t('profile.passwordShort', { n: LIMITS.accountPasswordMin }) })
    if (next !== repeat) return setMsg({ ok: false, text: t('profile.passwordMismatch') })
    setBusy(true)
    const err = await changePassword(current, next)
    setBusy(false)
    if (err) setMsg({ ok: false, text: err })
    else {
      setMsg({ ok: true, text: t('profile.passwordChanged') })
      setCurrent('')
      setNext('')
      setRepeat('')
    }
  }

  return (
    <div className="password-section">
      <div className="field-label">
        {t('profile.login')}: <b className="account-login">{account.login}</b>
      </div>
      {!open ? (
        <button className="btn btn-small btn-secondary" onClick={() => setOpen(true)}>
          {t('profile.changePassword')}
        </button>
      ) : (
        <form
          className="form"
          onSubmit={(e) => {
            e.preventDefault()
            void submit()
          }}
        >
          <input type="text" autoComplete="username" value={account.login} readOnly hidden />
          <label className="field">
            <span className="field-label">{t('profile.currentPassword')}</span>
            <input type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
          </label>
          <label className="field">
            <span className="field-label">{t('profile.newPassword')}</span>
            <input type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />
          </label>
          <label className="field">
            <span className="field-label">{t('profile.repeatPassword')}</span>
            <input type="password" autoComplete="new-password" value={repeat} onChange={(e) => setRepeat(e.target.value)} />
          </label>
          {msg && <div className={msg.ok ? 'success-box' : 'error-box'}>{msg.text}</div>}
          <button className="btn btn-small btn-primary" type="submit" disabled={busy || !current || !next}>
            {t('profile.changePassword')}
          </button>
        </form>
      )}
    </div>
  )
}
