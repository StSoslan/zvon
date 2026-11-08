import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import type { UserInfo } from '../../../shared/types'
import { useApp } from '../store/app'
import { openDm } from '../store/session'
import { Avatar } from './Common'
import { RoleTags, roleColor } from './MessageItem'

export function MemberList() {
  const { t } = useTranslation()
  const users = useApp((s) => s.users)
  const roles = useApp((s) => s.roles)
  const myId = useApp((s) => s.me?.id)

  const { online, offline } = useMemo(() => {
    const all = Object.values(users).sort((a, b) => a.nickname.localeCompare(b.nickname))
    return { online: all.filter((u) => u.online), offline: all.filter((u) => !u.online) }
  }, [users])

  const row = (u: UserInfo) => {
    const color = roleColor(u, roles)
    const self = u.id === myId
    return (
      <button
        key={u.id}
        className={u.online ? 'member' : 'member offline'}
        title={self ? undefined : t('members.write', { name: u.nickname })}
        disabled={self}
        onClick={() => void openDm(u.id)}
      >
        <Avatar id={u.id} nickname={u.nickname} size={32} online={u.online} />
        <span className="member-text">
          <span className="member-line">
            <span className="member-name" style={color ? { color } : undefined}>
              {u.nickname}
            </span>
            {u.isAdmin && <span className="tag">{t('members.admin')}</span>}
            <RoleTags user={u} roles={roles} />
            {self && <span className="member-you">{t('members.you')}</span>}
          </span>
          {u.status && <span className="member-status">{u.status}</span>}
        </span>
      </button>
    )
  }

  return (
    <aside className="members">
      <div className="members-group">{t('members.online', { count: online.length })}</div>
      {online.map(row)}
      {offline.length > 0 && <div className="members-group">{t('members.offline', { count: offline.length })}</div>}
      {offline.map(row)}
    </aside>
  )
}
