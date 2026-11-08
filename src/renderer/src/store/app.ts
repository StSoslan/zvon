import { create } from 'zustand'
import type { HostStatus, InitialState, ProbeResult, PttSupport, RecentServer } from '../../../preload/api'
import type { Channel, FileInfo, Message, Role, UnreadInfo, UserInfo, VoiceState } from '../../../shared/types'
import type { ConnStatus } from '../net/client'
import type { LocalMedia, RemoteVideoView, VoiceStatus } from '../voice/engine'
import { loadVoiceSettings, type VoiceSettings } from '../voice/settings'

export interface ChannelMessages {
  items: Message[]
  hasMore: boolean
  loading: boolean
  loaded: boolean
}

export interface PendingMessage {
  nonce: string
  channelId: string
  content: string
  attachments: FileInfo[]
  /** Сообщение, на которое отвечаем. */
  replyTo: Message | null
  createdAt: number
  failed: boolean
}

/** Поиск по сообщениям: запрос и найденное. */
export interface SearchState {
  open: boolean
  query: string
  /** Искать только в текущем канале. */
  currentOnly: boolean
  results: Message[]
  hasMore: boolean
  loading: boolean
  error: string | null
}

/** Что сейчас делает микрофон (для настроек): какое шумоподавление реально работает. */
export type MicProcessing = 'dfn' | 'rnnoise' | 'builtin' | 'off'

/** Файл в поле ввода: готовится, загружается или уже на хосте. */
export interface DraftAttachment {
  localId: string
  name: string
  size: number
  mime: string
  kind: 'image' | 'video' | 'audio' | 'file'
  /** blob:URL для превью до отправки. */
  previewUrl: string | null
  progress: number
  status: 'preparing' | 'uploading' | 'done' | 'error'
  error: string | null
  file: FileInfo | null
}

export interface LightboxState {
  file: FileInfo
  /** Все картинки сообщения — для листания стрелками. */
  gallery: FileInfo[]
}

export interface ConnTarget {
  host: string
  port: number
  password: string
  /** Ключ администратора сервера (для сервера на VPS); пусто — обычный вход. */
  adminToken?: string
  /** Логин аккаунта (сервер с аккаунтами); пусто — вход по нику. */
  login?: string
  remember: boolean
}

/** Ожидающее решение пользователя о доверии сертификату. */
export interface TrustPrompt {
  target: ConnTarget
  probe: Extract<ProbeResult, { ok: true }>
}

export interface AppState {
  boot: InitialState | null
  nickname: string
  recentServers: RecentServer[]
  hostStatus: HostStatus

  screen: 'connect' | 'main'
  connecting: boolean
  connectError: string | null
  trustPrompt: TrustPrompt | null

  connStatus: ConnStatus
  reconnectAttempt: number
  connNotice: string | null
  target: ConnTarget | null
  isOwnServer: boolean

  serverName: string
  me: UserInfo | null
  channels: Channel[]
  users: Record<string, UserInfo>
  currentChannelId: string | null
  messages: Record<string, ChannelMessages>
  pending: Record<string, PendingMessage[]>
  typing: Record<string, Record<string, number>>
  unread: Record<string, UnreadInfo>
  /**
   * Граница «новые сообщения» в открытом канале: первое непрочитанное на момент открытия.
   * Счётчик уже сброшен, а черта и кнопка «к непрочитанным» остаются, пока канал открыт.
   */
  newMark: Record<string, { firstUnreadId: number; count: number }>
  editingId: number | null
  /** Сообщение, на которое пишется ответ (по каналам). */
  replyTo: Record<string, Message>
  /** К какому сообщению прокрутить и подсветить (nonce меняется при каждом прыжке). */
  jump: { channelId: string; messageId: number; nonce: number } | null
  search: SearchState
  roles: Role[]
  statusPresets: string[]
  /** Публичный ключ push-уведомлений сервера; null — выключены. */
  pushKey: string | null
  /** Включены ли push на этом устройстве (веб-версия). */
  pushEnabled: boolean
  micProcessing: MicProcessing | null
  windowFocused: boolean

  /* ---- голос ---- */
  /** Канал, в котором мы хотим быть (сохраняется на время переподключений). */
  voiceChannelId: string | null
  voiceStatus: VoiceStatus
  voiceError: string | null
  micError: string | null
  /** Причина, по которой голос недоступен на сервере (null — работает). */
  serverVoiceError: string | null
  selfMuted: boolean
  selfDeafened: boolean
  pttPressed: boolean
  pttSupport: PttSupport | null
  voiceStates: Record<string, VoiceState>
  /** channelId → (userId → громкость dBov) для тех, кто говорит прямо сейчас. */
  speaking: Record<string, Record<string, number>>
  voiceSettings: VoiceSettings

  /* ---- видео ---- */
  /** Что показано в центре: чат или сцена голосового канала. */
  mainView: 'chat' | 'voice'
  remoteVideos: RemoteVideoView[]
  localMedia: LocalMedia
  /** Ошибка или предупреждение камеры/демонстрации. */
  mediaError: string | null
  screenPickerOpen: boolean
  /** Чьи демонстрации мы смотрим (userId → true). Демонстрации не включаются сами — канал хоста не тратится зря. */
  watching: Record<string, boolean>
  /** Плитка, развёрнутая на всю сцену. */
  focusedTile: string | null

  /* ---- файлы ---- */
  fileToken: string
  maxUploadBytes: number
  /** Логин аккаунта, если сервер работает с аккаунтами (иначе null). */
  account: { login: string } | null
  drafts: Record<string, DraftAttachment[]>
  lightbox: LightboxState | null
}

const emptyHost: HostStatus = {
  state: 'stopped',
  port: null,
  fingerprint: null,
  addresses: [],
  online: 0,
  error: null,
  rtcPort: null,
  voiceError: null
}

export const EMPTY_SEARCH: SearchState = { open: false, query: '', currentOnly: false, results: [], hasMore: false, loading: false, error: null }

export const initialServerState = {
  serverName: '',
  me: null,
  channels: [],
  users: {},
  currentChannelId: null,
  messages: {},
  pending: {},
  typing: {},
  unread: {},
  newMark: {},
  editingId: null,
  replyTo: {},
  jump: null,
  search: EMPTY_SEARCH,
  roles: [],
  statusPresets: [],
  pushKey: null,
  pushEnabled: false,
  micProcessing: null,
  voiceChannelId: null,
  voiceStatus: 'idle',
  voiceError: null,
  micError: null,
  serverVoiceError: null,
  voiceStates: {},
  speaking: {},
  pttPressed: false,
  mainView: 'chat',
  remoteVideos: [],
  localMedia: { camera: null, screen: null, screenHasAudio: false },
  mediaError: null,
  screenPickerOpen: false,
  watching: {},
  focusedTile: null,
  fileToken: '',
  maxUploadBytes: 0,
  account: null,
  drafts: {},
  lightbox: null
} satisfies Partial<AppState>

export const useApp = create<AppState>(() => ({
  boot: null,
  nickname: '',
  recentServers: [],
  hostStatus: emptyHost,
  screen: 'connect',
  connecting: false,
  connectError: null,
  trustPrompt: null,
  connStatus: 'closed',
  reconnectAttempt: 0,
  connNotice: null,
  target: null,
  isOwnServer: false,
  windowFocused: typeof document !== 'undefined' ? document.hasFocus() : true,
  selfMuted: false,
  selfDeafened: false,
  pttSupport: null,
  voiceSettings: loadVoiceSettings(),
  ...initialServerState
}))

export const getApp = useApp.getState
export const setApp = useApp.setState

/** Мутации списка сообщений канала. */
export function patchChannel(channelId: string, fn: (c: ChannelMessages) => ChannelMessages): void {
  setApp((s) => {
    const cur = s.messages[channelId] ?? { items: [], hasMore: true, loading: false, loaded: false }
    return { messages: { ...s.messages, [channelId]: fn(cur) } }
  })
}

/** Вставка с удалением дублей и сохранением порядка по id. */
export function mergeMessages(a: Message[], b: Message[]): Message[] {
  const map = new Map<number, Message>()
  for (const m of a) map.set(m.id, m)
  for (const m of b) map.set(m.id, m)
  return [...map.values()].sort((x, y) => x.id - y.id)
}
