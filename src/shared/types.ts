import type { ErrorCode } from './constants'

/** dm — личная переписка двух участников (у каждого свой список таких каналов). */
export type ChannelType = 'text' | 'voice' | 'dm'

export interface Channel {
  id: string
  /** У личного канала пустое: клиент показывает имя собеседника. */
  name: string
  type: ChannelType
  position: number
  /** Участники личного канала (два id); у остальных каналов отсутствует. */
  members?: string[]
}

/** Роль участника — метка с цветом, которую выдаёт администратор (прав не даёт). */
export interface Role {
  id: string
  name: string
  /** Цвет в формате #rrggbb. */
  color: string
  position: number
}

export interface UserInfo {
  id: string
  nickname: string
  /** id файла аватарки на хосте (null — буквенная аватарка). */
  avatar: string | null
  online: boolean
  isAdmin: boolean
  /** Статус, который участник выбрал или вписал сам («отошёл, буду в 17:30»); null — без статуса. */
  status: string | null
  /** id ролей (в порядке ролей сервера). */
  roles: string[]
}

/** Аккаунт для входа по логину (сервер с аккаунтами). Видит только администратор. */
export interface AccountInfo {
  id: string
  login: string
  nickname: string
  isAdmin: boolean
  disabled: boolean
  online: boolean
  createdAt: number
  lastSeen: number | null
}

export type FileKind = 'image' | 'video' | 'audio' | 'file' | 'avatar'

/** Файл, хранящийся на хосте. */
export interface FileInfo {
  id: string
  name: string
  mime: string
  size: number
  kind: FileKind
  width: number | null
  height: number | null
  /** Длительность видео/аудио в секундах. */
  duration: number | null
  /** Миниатюра (для фото и видео), сгенерированная клиентом при загрузке. */
  thumbId: string | null
}

/** Сообщение, на которое отвечают: короткая выжимка для цитаты. */
export interface ReplyRef {
  id: number
  authorId: string
  authorName: string
  /** Начало текста (обрезано до LIMITS.replySnippetLength). */
  content: string
  /** Сколько файлов было в исходном сообщении. */
  attachments: number
  /** Исходное сообщение уже удалено. */
  deleted: boolean
}

export interface Message {
  /** Монотонный id — по нему же идёт пагинация истории. */
  id: number
  channelId: string
  authorId: string
  /** Ник автора на момент отправки (на случай, если пользователь больше не известен). */
  authorName: string
  content: string
  /** id упомянутых пользователей; 'everyone' — упоминание всех. */
  mentions: string[]
  attachments: FileInfo[]
  /** Ответ на другое сообщение этого же канала. */
  replyTo: ReplyRef | null
  createdAt: number
  editedAt: number | null
  /** Эхо клиентского nonce — чтобы отправитель сопоставил своё сообщение. */
  nonce?: string
}

/** Непрочитанное в канале для конкретного участника. */
export interface UnreadInfo {
  /** Последнее прочитанное сообщение (0 — ничего не читал). */
  lastReadId: number
  count: number
  /** Сколько из них — упоминания, ответы или личные сообщения. */
  mentions: number
  /** Первое непрочитанное — к нему ведёт кнопка «к непрочитанным». */
  firstUnreadId: number | null
}

/** Подписка браузера на push (то, что отдаёт PushSubscription.toJSON()). */
export interface PushSubscriptionJson {
  endpoint: string
  keys: { p256dh: string; auth: string }
}

/* ---------------- Голос и медиа ---------------- */

/** Непрозрачные структуры mediasoup (rtpParameters, dtlsParameters и т. п.) передаются как есть. */
export type MediaJson = Record<string, unknown>

export type MediaKind = 'audio' | 'video'
/** Источник потока: микрофон, камера, демонстрация экрана и её звук. */
export type MediaSource = 'mic' | 'camera' | 'screen' | 'screen-audio'

export interface VoiceState {
  userId: string
  channelId: string
  muted: boolean
  deafened: boolean
  joinedAt: number
  /** Показывает свой экран прямо сейчас. */
  streaming: boolean
  /** Чьи демонстрации экрана смотрит (userId ведущих). */
  watching: string[]
}

export interface ProducerInfo {
  producerId: string
  userId: string
  channelId: string
  kind: MediaKind
  source: MediaSource
  paused: boolean
}

export interface TransportInfo {
  id: string
  iceParameters: MediaJson
  iceCandidates: MediaJson[]
  dtlsParameters: MediaJson
}

export interface ConsumerInfo {
  consumerId: string
  producerId: string
  userId: string
  kind: MediaKind
  source: MediaSource
  rtpParameters: MediaJson
  producerPaused: boolean
  /** Сколько пространственных/временных слоёв у потока (1 — без simulcast/SVC). */
  spatialLayers: number
  temporalLayers: number
}

/* ---------------- Панель хоста ---------------- */

/** Настройки сервера, меняющиеся на лету (хранятся в БД хоста). */
export interface AdminSettings {
  /** Максимум входящего потока от одного клиента, кбит/с. */
  maxIncomingKbps: number
  /** Максимум исходящего потока к одному клиенту, кбит/с (0 — без ограничения). */
  maxOutgoingKbps: number
  maxUploadMb: number
}

export interface AdminUserStats {
  userId: string
  nickname: string
  ip: string
  isAdmin: boolean
  voiceChannelId: string | null
  /** Хост → клиент, кбит/с. */
  sendKbps: number
  /** Клиент → хост, кбит/с. */
  recvKbps: number
  producers: number
  consumers: number
  connectedAt: number
}

export interface AdminStats {
  uptimeSec: number
  memoryMb: number
  users: AdminUserStats[]
  sfu: {
    available: boolean
    error: string | null
    cpuPercent: number
    rooms: number
    producers: number
    consumers: number
    sendKbps: number
    recvKbps: number
    rtcPort: number
    listenIps: string[]
  }
  files: { totalBytes: number }
  settings: AdminSettings
  banned: Array<{ userId: string; nickname: string }>
}

export interface ServerSnapshot {
  serverName: string
  serverVersion: string
  /** Каналы сервера и личные каналы этого участника. */
  channels: Channel[]
  users: UserInfo[]
  you: UserInfo
  roles: Role[]
  /** Готовые статусы (по умолчанию и добавленные администратором). */
  statusPresets: string[]
  /** Непрочитанное по каналам (только где оно есть). */
  unread: Record<string, UnreadInfo>
  /** Публичный ключ VAPID для push-уведомлений; null — push на сервере выключен. */
  pushKey: string | null
  voiceStates: VoiceState[]
  /** null — голос работает; иначе причина, почему SFU недоступен. */
  voiceError: string | null
  /** Токен для HTTP-запросов к файлам (?t= или Authorization: Bearer). */
  fileToken: string
  maxUploadBytes: number
  /** Вход по аккаунту: логин текущего пользователя; null — сервер без аккаунтов. */
  account: { login: string } | null
}

/* ---------------- Запросы клиент → сервер и ответы на них ---------------- */

export interface RequestMap {
  hello: {
    protocol: number
    clientId: string
    nickname: string
    password: string
    adminToken?: string
    /** Логин аккаунта — на сервере с аккаунтами (тогда password — пароль аккаунта, nickname не используется). */
    login?: string
  }
  'password-change': { oldPassword: string; newPassword: string }
  ping: Record<string, never>
  'msg-send': { channelId: string; content: string; nonce?: string; attachments?: string[]; replyTo?: number }
  'msg-edit': { messageId: number; content: string }
  'msg-delete': { messageId: number }
  'msg-history': { channelId: string; before?: number; limit?: number }
  /** Прочитано до этого сообщения включительно. */
  'msg-read': { channelId: string; messageId: number }
  /** Поиск по тексту сообщений (во всех доступных каналах или в одном). */
  'msg-search': { query: string; channelId?: string; before?: number; limit?: number }
  /** Свой статус: текст или null (убрать). */
  'status-set': { text: string | null }
  /** Личная переписка с участником: открыть (создать, если ещё нет). */
  'dm-open': { userId: string }
  'push-subscribe': { subscription: PushSubscriptionJson }
  'push-unsubscribe': { endpoint: string }
  /** avatar: id загруженного файла, null — убрать аватарку, не указан — не менять. */
  'profile-update': { nickname: string; avatar?: string | null }
  typing: { channelId: string }

  'voice-join': { channelId: string }
  'voice-ready': { rtpCapabilities: MediaJson }
  'voice-leave': Record<string, never>
  'voice-state-update': { muted: boolean; deafened: boolean }
  'transport-create': { direction: 'send' | 'recv' }
  'transport-connect': { transportId: string; dtlsParameters: MediaJson }
  'transport-restart-ice': { transportId: string }
  produce: { transportId: string; kind: MediaKind; rtpParameters: MediaJson; source: MediaSource; paused?: boolean }
  'producer-close': { producerId: string }
  'producer-pause': { producerId: string }
  'producer-resume': { producerId: string }
  consume: { producerId: string }
  'consumer-resume': { consumerId: string }
  'consumer-pause': { consumerId: string }
  'consumer-set-layers': { consumerId: string; spatialLayer: number; temporalLayer?: number }

  /* только для администратора (хоста) */
  'admin-stats': Record<string, never>
  'admin-settings': Partial<AdminSettings>
  'admin-kick': { userId: string; ban: boolean }
  'admin-unban': { userId: string }
  'channel-create': { name: string; type: ChannelType }
  'channel-rename': { channelId: string; name: string }
  'channel-delete': { channelId: string }
  'channel-move': { channelId: string; direction: 'up' | 'down' }
  'account-list': Record<string, never>
  'account-create': { login: string; password: string; isAdmin: boolean }
  /** password — задать новый пароль; disabled — запретить вход. */
  'account-update': { accountId: string; password?: string; isAdmin?: boolean; disabled?: boolean }
  'account-delete': { accountId: string }
  'status-presets-set': { presets: string[] }
  'role-create': { name: string; color: string }
  'role-update': { roleId: string; name?: string; color?: string }
  'role-delete': { roleId: string }
  'role-assign': { userId: string; roleId: string; assigned: boolean }
}

export interface ResponseMap {
  hello: ServerSnapshot
  ping: { time: number }
  'msg-send': { message: Message }
  'msg-edit': { message: Message }
  'msg-delete': { messageId: number }
  'msg-history': { channelId: string; messages: Message[]; hasMore: boolean }
  'msg-read': Record<string, never>
  'msg-search': { messages: Message[]; hasMore: boolean }
  'status-set': { user: UserInfo }
  'dm-open': { channel: Channel }
  'push-subscribe': Record<string, never>
  'push-unsubscribe': Record<string, never>
  'profile-update': { user: UserInfo }
  typing: Record<string, never>

  'voice-join': { channelId: string; routerRtpCapabilities: MediaJson }
  'voice-ready': { producers: ProducerInfo[] }
  'voice-leave': Record<string, never>
  'voice-state-update': { state: VoiceState }
  'transport-create': TransportInfo
  'transport-connect': Record<string, never>
  'transport-restart-ice': { iceParameters: MediaJson }
  produce: { producerId: string }
  'producer-close': Record<string, never>
  'producer-pause': Record<string, never>
  'producer-resume': Record<string, never>
  consume: ConsumerInfo
  'consumer-resume': Record<string, never>
  'consumer-pause': Record<string, never>
  'consumer-set-layers': Record<string, never>

  'admin-stats': AdminStats
  'admin-settings': { settings: AdminSettings }
  'admin-kick': Record<string, never>
  'admin-unban': Record<string, never>
  'channel-create': { channel: Channel }
  'channel-rename': { channel: Channel }
  'channel-delete': Record<string, never>
  'channel-move': Record<string, never>
  'password-change': Record<string, never>
  'account-list': { accounts: AccountInfo[] }
  'account-create': { account: AccountInfo }
  'account-update': { account: AccountInfo }
  'account-delete': Record<string, never>
  'status-presets-set': { presets: string[] }
  'role-create': { role: Role }
  'role-update': { role: Role }
  'role-delete': Record<string, never>
  'role-assign': { user: UserInfo }
}

export type RequestType = keyof RequestMap

/* ---------------- События сервер → клиент ---------------- */

export interface EventMap {
  'msg-new': { message: Message }
  'msg-updated': { message: Message }
  'msg-deleted': { messageId: number; channelId: string }
  typing: { channelId: string; userId: string }
  'user-joined': { user: UserInfo }
  'user-left': { userId: string }
  'user-updated': { user: UserInfo }
  'channels-updated': { channels: Channel[] }
  /** Другое устройство этого же участника прочитало канал. */
  'channel-read': { channelId: string; lastReadId: number }
  'roles-updated': { roles: Role[] }
  'status-presets': { presets: string[] }
  'server-closing': { reason: string }

  /** state = null — пользователь вышел из голоса. */
  'voice-state': { userId: string; state: VoiceState | null }
  'new-producer': ProducerInfo
  'producer-closed': { producerId: string; userId: string }
  'consumer-closed': { consumerId: string; producerId: string }
  /** Кто сейчас говорит: userId → громкость в dBov (−127…0). Пустой объект — тишина. */
  speaking: { channelId: string; levels: Record<string, number> }
  'active-speaker': { channelId: string; userId: string | null }
  /** Какой слой качества сейчас реально приходит (null — ничего, например при паузе). */
  'consumer-layers': { consumerId: string; spatialLayer: number | null; temporalLayer: number | null }
  /** Хост изменил настройки, важные клиентам. */
  'server-settings': { maxUploadBytes: number }
  /** SFU перезапущен — клиенты в голосе должны переподключиться. */
  'voice-reset': { reason: string }
  /** Голос перехватило другое устройство этого же участника: здесь из канала нужно выйти без повторного входа. */
  'voice-taken': { reason: string }
}

export type EventType = keyof EventMap

/* ---------------- Конверты ---------------- */

export interface ClientEnvelope {
  t: string
  id?: number
  d?: unknown
}

export interface ErrorPayload {
  code: ErrorCode
  message: string
}

export type ServerEnvelope =
  | { t: 'res'; id: number; ok: true; d: unknown }
  | { t: 'res'; id: number; ok: false; err: ErrorPayload }
  | { t: EventType; d: unknown }
