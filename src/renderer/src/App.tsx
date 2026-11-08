import { useEffect, useState } from 'react'
import { ChatIcon, HashIcon, MenuIcon, SearchIcon, UsersIcon, VolumeIcon } from './components/Icons'
import { ChatView } from './components/ChatView'
import { ConnectScreen } from './components/ConnectScreen'
import { MemberList } from './components/MemberList'
import { Sidebar } from './components/Sidebar'
import { VoiceStage } from './components/VoiceStage'
import { Lightbox } from './components/Attachments'
import { useApp } from './store/app'
import { bootApp, cleanError, dmPartner, openSearch } from './store/session'

export function App() {
  const booted = useApp((s) => s.boot !== null)
  const screen = useApp((s) => s.screen)
  const showStage = useApp((s) => s.mainView === 'voice' && s.voiceChannelId !== null)
  const [bootError, setBootError] = useState<string | null>(null)
  // Телефон: каналы и участники открываются выдвижными панелями.
  const [drawer, setDrawer] = useState<'none' | 'channels' | 'members'>('none')
  const currentChannelId = useApp((s) => s.currentChannelId)
  const mainView = useApp((s) => s.mainView)
  useEffect(() => setDrawer('none'), [currentChannelId, mainView, screen])

  useEffect(() => {
    bootApp().catch((err) => setBootError(cleanError(err)))
    // Файл, брошенный мимо чата, не должен открываться вместо приложения.
    const stop = (e: DragEvent): void => e.preventDefault()
    window.addEventListener('dragover', stop)
    window.addEventListener('drop', stop)
    return () => {
      window.removeEventListener('dragover', stop)
      window.removeEventListener('drop', stop)
    }
  }, [])

  if (bootError) return <div className="splash error">Не удалось запустить Zvon: {bootError}</div>
  if (!booted) return <div className="splash">Zvon</div>

  if (screen === 'connect') return <ConnectScreen />
  return (
    <div className={`layout drawer-${drawer}`}>
      <MobileBar
        stage={showStage}
        onChannels={() => setDrawer((d) => (d === 'channels' ? 'none' : 'channels'))}
        onMembers={() => setDrawer((d) => (d === 'members' ? 'none' : 'members'))}
      />
      <Sidebar />
      {showStage ? <VoiceStage /> : <ChatView />}
      <MemberList />
      <div className="drawer-backdrop" onClick={() => setDrawer('none')} />
      <Lightbox />
    </div>
  )
}

/** Верхняя панель на узком экране (телефон): кнопки каналов и участников. */
function MobileBar({ stage, onChannels, onMembers }: { stage: boolean; onChannels: () => void; onMembers: () => void }) {
  const channel = useApp((s) => s.channels.find((c) => c.id === (stage ? s.voiceChannelId : s.currentChannelId)))
  const unread = useApp((s) => Object.values(s.unread).some((u) => u.count > 0))
  const myId = useApp((s) => s.me?.id)
  const searchOpen = useApp((s) => s.search.open)
  const isDm = channel?.type === 'dm'
  const title = isDm ? (dmPartner(channel, myId)?.nickname ?? '?') : (channel?.name ?? 'Zvon')
  return (
    <header className="mobile-bar">
      <button className="icon-btn" onClick={onChannels} aria-label="Каналы">
        <MenuIcon width={22} height={22} />
        {unread && <span className="mobile-dot" />}
      </button>
      <span className="mobile-title">
        {stage ? <VolumeIcon width={18} height={18} /> : isDm ? <ChatIcon width={18} height={18} /> : <HashIcon width={18} height={18} />}
        {title}
      </span>
      {!stage && channel && (
        <button className={searchOpen ? 'icon-btn active' : 'icon-btn'} onClick={() => openSearch(!searchOpen)} aria-label="Поиск">
          <SearchIcon width={22} height={22} />
        </button>
      )}
      <button className="icon-btn" onClick={onMembers} aria-label="Участники">
        <UsersIcon width={22} height={22} />
      </button>
    </header>
  )
}
