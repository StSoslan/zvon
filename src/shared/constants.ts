/** Версия протокола WebSocket. Клиент и сервер с разными версиями не соединяются. */
export const PROTOCOL_VERSION = 6

export const APP_NAME = 'Zvon'

export const DEFAULT_PORT = 7777

/** Порт медиа (UDP и TCP) для WebRtcServer mediasoup. */
export const DEFAULT_RTC_PORT = 40000

/** Ограничения битрейта по умолчанию (настраиваются в панели хоста на этапе 5). */
export const BITRATE = {
  /** Максимум входящего потока от одного клиента, бит/с. */
  maxIncomingPerTransport: 15_000_000,
  /** Начальная оценка исходящего канала к клиенту, бит/с. */
  initialOutgoing: 1_500_000,
  /** Целевой битрейт голоса Opus, бит/с. */
  opusMaxAverage: 64_000
} as const

export const LIMITS = {
  messageLength: 4000,
  nicknameLength: 32,
  passwordLength: 128,
  accountPasswordMin: 6,
  serverNameLength: 48,
  channelNameLength: 40,
  historyPage: 50,
  historyPageMax: 100,
  attachmentsPerMessage: 10,
  /** Текст статуса участника («отошёл, буду в 17:30»). */
  statusLength: 80,
  statusPresets: 20,
  roleNameLength: 32,
  rolesMax: 30,
  searchQueryLength: 100,
  searchPage: 30,
  /** Сколько сообщений показывать в цитате ответа (символов). */
  replySnippetLength: 160,
  fileNameLength: 200,
  /** Лимит размера файла по умолчанию, МБ (меняется хостом). */
  defaultMaxUploadMb: 500,
  avatarBytes: 5 * 1024 * 1024,
  thumbBytes: 2 * 1024 * 1024,
  /** Максимальный размер одного WS-кадра от клиента, байт. */
  wsMaxPayload: 64 * 1024
} as const

export const TIMINGS = {
  /** Сколько сервер ждёт hello после открытия сокета. */
  helloTimeoutMs: 10_000,
  /** Сколько сервер держит «отключившегося» пользователя, прежде чем объявить его вышедшим. */
  reconnectGraceMs: 15_000,
  /** Как часто клиент шлёт ping. */
  clientPingIntervalMs: 15_000,
  /** Если ответ на ping не пришёл за это время — соединение считается мёртвым. */
  clientPingTimeoutMs: 10_000,
  /** Как часто сервер проверяет живость сокетов (WS ping/pong). */
  serverHeartbeatMs: 20_000,
  /** Клиент шлёт «печатает» не чаще этого интервала. */
  typingThrottleMs: 3_000,
  /** Сколько показывать «печатает…» после последнего события. */
  typingDisplayMs: 6_000,
  /** Сообщения одного автора подряд в пределах этого окна группируются. */
  messageGroupWindowMs: 5 * 60_000
} as const

export const ErrorCode = {
  BadRequest: 'bad_request',
  NotAuthenticated: 'not_authenticated',
  WrongPassword: 'wrong_password',
  VersionMismatch: 'version_mismatch',
  NotFound: 'not_found',
  Forbidden: 'forbidden',
  RateLimited: 'rate_limited',
  Internal: 'internal'
} as const

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode]

/** Коды закрытия WebSocket, которые клиент обрабатывает особо (без автоповтора). */
export const CloseCode = {
  Normal: 1000,
  ServerShutdown: 1001,
  HelloTimeout: 4000,
  Replaced: 4001,
  AuthFailed: 4002,
  Kicked: 4003
} as const
