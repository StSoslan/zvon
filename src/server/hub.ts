/**
 * Хаб: принимает WebSocket-подключения, проверяет hello, маршрутизирует запросы,
 * рассылает события и отслеживает присутствие пользователей.
 *
 * Один участник может быть подключён с нескольких устройств сразу: у каждого своя сессия,
 * «в сети» он, пока жива хотя бы одна. Голос при этом ведёт только одно устройство —
 * то, что вошло в голосовой канал последним.
 */
import { createHash, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import type { RawData, WebSocket, WebSocketServer } from 'ws'
import { BITRATE, CloseCode, ErrorCode, LIMITS, PROTOCOL_VERSION, TIMINGS } from '../shared/constants'
import { isRequestType, parseRequest } from '../shared/schemas'
import type {
  AccountInfo,
  AdminSettings,
  AdminStats,
  Channel,
  ClientEnvelope,
  EventMap,
  EventType,
  Message,
  RequestMap,
  RequestType,
  ResponseMap,
  ServerSnapshot,
  UserInfo
} from '../shared/types'
import type { ServerConfig } from './config'
import { DUMMY_HASH, hashPassword, verifyPassword } from './accounts'
import type { StoredAccount, StoredUser, ZvonDb } from './db'
import type { FileService } from './files'
import type { Logger } from './logger'
import { PushService } from './push'
import { ClientSession, RequestError } from './session'
import type { SfuService } from './sfu'
import { VoiceManager } from './voice'

type Handler<K extends RequestType> = (s: ClientSession, data: RequestMap[K]) => ResponseMap[K] | Promise<ResponseMap[K]>
type Handlers = { [K in RequestType]: Handler<K> }

/** Запросы, которые не тратят лимит частоты (служебные и массовые при входе в голос). */
const RATE_EXEMPT = new Set<RequestType>([
  'ping',
  'typing',
  'msg-read',
  'consume',
  'consumer-resume',
  'consumer-pause',
  'transport-connect',
  'voice-state-update',
  'producer-pause',
  'producer-resume',
  'consumer-set-layers'
])

function hashSecret(s: string): Buffer {
  return createHash('sha256').update(s, 'utf8').digest()
}

function secretEquals(a: string, b: string): boolean {
  return timingSafeEqual(hashSecret(a), hashSecret(b))
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

const MAX_PASSWORD_FAILS = 10
const PASSWORD_LOCK_MS = 15 * 60 * 1000
const PUSH_BODY_MAX = 120

export class Hub {
  private sessions = new Set<ClientSession>()
  /** Живые сессии каждого вошедшего пользователя (несколько устройств). */
  private byUser = new Map<string, Set<ClientSession>>()
  /** Сессия, которая ведёт голос пользователя (вошла в голосовой канал). */
  private voiceOwner = new Map<string, ClientSession>()
  /** Голос «осиротел» (его сессия оборвалась): ждём переподключения, потом выходим из канала. */
  private voiceOrphanTimers = new Map<string, NodeJS.Timeout>()
  /** Пользователи, у которых оборвалась связь на всех устройствах: ждём переподключения. */
  private pendingLeave = new Map<string, { timer: NodeJS.Timeout; nickname: string; isAdmin: boolean }>()
  private nextConnId = 1
  private heartbeat: NodeJS.Timeout | null = null
  private readonly handlers: Handlers
  private closing = false
  readonly voice: VoiceManager
  readonly push: PushService
  /** Заблокированные хостом до перезапуска сервера: userId → ник. */
  private banned = new Map<string, string>()
  /** Неудачные попытки пароля по IP: после MAX_PASSWORD_FAILS вход с адреса закрыт на PASSWORD_LOCK_MS. */
  private passwordFails = new Map<string, { count: number; firstAt: number }>()
  private readonly startedAt = Date.now()
  private settings: AdminSettings
  /** Вызывается, когда хост меняет настройки в панели (чтобы main сохранил лимит файла). */
  onSettingsChanged: (s: AdminSettings) => void = () => undefined

  constructor(
    private wss: WebSocketServer,
    private db: ZvonDb,
    private cfg: ServerConfig,
    private sfu: SfuService,
    private files: FileService,
    private log: Logger,
    private onOnlineChange: (count: number) => void
  ) {
    this.push = new PushService(db, log.child('push'))
    this.voice = new VoiceManager(
      sfu,
      {
        send: (userId, t, d) => this.voiceOwner.get(userId)?.event(t, d),
        broadcast: (t, d) => this.broadcast(t, d),
        isVoiceChannel: (channelId) => this.db.getChannel(channelId)?.type === 'voice'
      },
      log.child('voice')
    )
    const num = (key: string): number | null => {
      const v = Number(db.getSetting(key))
      return db.getSetting(key) !== null && Number.isFinite(v) ? v : null
    }
    this.settings = {
      maxIncomingKbps: num('maxIncomingKbps') ?? BITRATE.maxIncomingPerTransport / 1000,
      maxOutgoingKbps: num('maxOutgoingKbps') ?? 0,
      // Лимит файла из запуска хоста главнее сохранённого.
      maxUploadMb: cfg.maxUploadMb
    }
    sfu.limits = { incoming: this.settings.maxIncomingKbps * 1000, outgoing: this.settings.maxOutgoingKbps * 1000 }

    const v = this.voice
    const admin = <T>(fn: (s: ClientSession) => T) => (s: ClientSession): T => {
      if (!s.isAdmin) throw new RequestError(ErrorCode.Forbidden, 'Это может только хост')
      return fn(s)
    }
    this.handlers = {
      'admin-stats': admin(() => this.adminStats()),
      'admin-settings': (s, d) => admin(() => this.updateSettings(d))(s),
      'admin-kick': (s, d) => admin((self) => this.kick(self, d))(s),
      'admin-unban': (s, d) =>
        admin(() => {
          this.banned.delete(d.userId)
          return {}
        })(s),
      'channel-create': (s, d) => admin(() => this.createChannel(d))(s),
      'channel-rename': (s, d) => admin(() => this.renameChannel(d))(s),
      'channel-delete': (s, d) => admin(() => this.deleteChannel(d))(s),
      'channel-move': (s, d) =>
        admin(() => {
          if (!this.db.getChannel(d.channelId)) throw new RequestError(ErrorCode.NotFound, 'Канал не найден')
          this.db.moveChannel(d.channelId, d.direction)
          this.broadcastChannels()
          return {}
        })(s),
      'account-list': admin(() => ({ accounts: this.requireAccounts().listAccounts().map((a) => this.accountInfo(a)) })),
      'account-create': (s, d) => admin(() => this.createAccount(d))(s),
      'account-update': (s, d) => admin((self) => this.updateAccount(self, d))(s),
      'account-delete': (s, d) => admin((self) => this.deleteAccount(self, d))(s),
      'status-presets-set': (s, d) => admin(() => this.setStatusPresets(d))(s),
      'role-create': (s, d) => admin(() => this.createRole(d))(s),
      'role-update': (s, d) => admin(() => this.updateRole(d))(s),
      'role-delete': (s, d) => admin(() => this.deleteRole(d))(s),
      'role-assign': (s, d) => admin(() => this.assignRole(d))(s),
      'password-change': (s, d) => this.changePassword(s, d),
      hello: (s, d) => this.handleHello(s, d),
      ping: () => ({ time: Date.now() }),
      'msg-send': (s, d) => this.handleSend(s, d),
      'msg-edit': (s, d) => this.handleEdit(s, d),
      'msg-delete': (s, d) => this.handleDelete(s, d),
      'msg-history': (s, d) => this.handleHistory(s, d),
      'msg-read': (s, d) => this.handleRead(s, d),
      'msg-search': (s, d) => this.handleSearch(s, d),
      'status-set': (s, d) => this.setStatus(s, d),
      'dm-open': (s, d) => this.openDm(s, d),
      'push-subscribe': (s, d) => {
        this.push.subscribe(s.userId!, d.subscription)
        return {}
      },
      'push-unsubscribe': (_s, d) => {
        this.push.unsubscribe(d.endpoint)
        return {}
      },
      'profile-update': (s, d) => this.handleProfile(s, d),
      typing: (s, d) => this.handleTyping(s, d),
      'voice-join': (s, d) => this.voiceJoin(s, d),
      'voice-ready': (s, d) => v.ready(s.userId!, d),
      'voice-leave': (s) => {
        if (this.voiceOwner.get(s.userId!) === s) this.voiceOwner.delete(s.userId!)
        v.leave(s.userId!)
        return {}
      },
      'voice-state-update': (s, d) => v.updateState(s.userId!, d),
      'transport-create': (s, d) => v.createTransport(s.userId!, d),
      'transport-connect': (s, d) => v.connectTransport(s.userId!, d),
      'transport-restart-ice': (s, d) => v.restartIce(s.userId!, d),
      produce: (s, d) => v.produce(s.userId!, d),
      'producer-close': (s, d) => v.closeProducer(s.userId!, d),
      'producer-pause': (s, d) => v.pauseProducer(s.userId!, d),
      'producer-resume': (s, d) => v.resumeProducer(s.userId!, d),
      consume: (s, d) => v.consume(s.userId!, d),
      'consumer-resume': (s, d) => v.resumeConsumer(s.userId!, d),
      'consumer-pause': (s, d) => v.pauseConsumer(s.userId!, d),
      'consumer-set-layers': (s, d) => v.setConsumerLayers(s.userId!, d)
    }
  }

  start(): void {
    this.wss.on('connection', (ws, req) => this.onConnection(ws, req))
    this.heartbeat = setInterval(() => this.checkAlive(), TIMINGS.serverHeartbeatMs)
  }

  get voiceAvailable(): boolean {
    return this.sfu.available
  }

  get onlineCount(): number {
    return this.byUser.size + this.pendingLeave.size
  }

  /* ======================= подключения ======================= */

  private onConnection(ws: WebSocket, req: IncomingMessage): void {
    if (this.closing) {
      ws.close(CloseCode.ServerShutdown, 'shutting down')
      return
    }
    let remote = (req.socket.remoteAddress ?? '?').replace(/^::ffff:/, '')
    // За обратным прокси на этой же машине настоящий адрес клиента — в X-Forwarded-For.
    const forwarded = req.headers['x-forwarded-for']
    if (this.cfg.trustProxy && (remote === '127.0.0.1' || remote === '::1') && typeof forwarded === 'string') {
      remote = forwarded.split(',')[0].trim().replace(/^::ffff:/, '') || remote
    }
    const s = new ClientSession(ws, this.nextConnId++, remote, this.log)
    this.sessions.add(s)
    this.log.info(`Новое подключение ${s.label}`)

    s.helloTimer = setTimeout(() => {
      if (!s.authenticated) {
        this.log.warn(`${s.label}: не прислал hello вовремя`)
        s.close(CloseCode.HelloTimeout, 'hello timeout')
      }
    }, TIMINGS.helloTimeoutMs)

    ws.on('pong', () => {
      s.isAlive = true
    })
    ws.on('message', (raw, isBinary) => {
      if (isBinary) {
        this.strike(s, 'бинарный кадр')
        return
      }
      void this.onFrame(s, raw)
    })
    ws.on('close', (code) => this.onClose(s, code))
    ws.on('error', (err) => this.log.warn(`Ошибка сокета ${s.label}`, err))
  }

  private strike(s: ClientSession, why: string): void {
    s.badFrames++
    this.log.warn(`${s.label}: неверный кадр (${why}), всего ${s.badFrames}`)
    if (s.badFrames >= 10) s.close(CloseCode.Normal, 'too many bad frames')
  }

  private async onFrame(s: ClientSession, raw: RawData): Promise<void> {
    let env: ClientEnvelope
    try {
      const text = Array.isArray(raw) ? Buffer.concat(raw).toString('utf8') : raw.toString()
      const parsed: unknown = JSON.parse(text)
      if (!parsed || typeof parsed !== 'object' || typeof (parsed as ClientEnvelope).t !== 'string') {
        throw new Error('нет поля t')
      }
      env = parsed as ClientEnvelope
    } catch (err) {
      this.strike(s, (err as Error).message)
      return
    }

    const { t, id } = env
    const reqId = typeof id === 'number' ? id : 0
    const fail = (code: ErrorCode, message: string): void => {
      if (reqId) s.replyError(reqId, code, message)
    }

    if (!isRequestType(t)) {
      fail(ErrorCode.BadRequest, `Неизвестный тип запроса: ${t}`)
      return
    }
    if (!s.authenticated && t !== 'hello') {
      fail(ErrorCode.NotAuthenticated, 'Сначала нужно представиться (hello)')
      return
    }
    if (!RATE_EXEMPT.has(t) && !s.take()) {
      fail(ErrorCode.RateLimited, 'Слишком много запросов, подождите немного')
      return
    }
    const parsed = parseRequest(t, env.d)
    if (!parsed.ok) {
      fail(ErrorCode.BadRequest, parsed.message)
      return
    }
    try {
      const handler = this.handlers[t] as Handler<typeof t>
      const result = await handler(s, parsed.data)
      if (reqId) s.reply(reqId, result)
    } catch (err) {
      if (err instanceof RequestError) {
        fail(err.code, err.message)
      } else {
        this.log.error(`Ошибка обработки ${t} от ${s.label}`, err)
        fail(ErrorCode.Internal, 'Внутренняя ошибка сервера')
      }
    }
  }

  private onClose(s: ClientSession, code: number): void {
    this.sessions.delete(s)
    if (s.helloTimer) clearTimeout(s.helloTimer)
    this.log.info(`Отключение ${s.label}, код ${code}`)
    const userId = s.userId
    if (!userId) return
    const set = this.byUser.get(userId)
    if (!set?.has(s)) return
    set.delete(s)

    // Голос вело это устройство: даём ему время переподключиться, потом выходим из канала.
    if (this.voiceOwner.get(userId) === s) {
      const timer = setTimeout(() => {
        this.voiceOrphanTimers.delete(userId)
        if (this.voiceOwner.get(userId) === s) {
          this.voiceOwner.delete(userId)
          this.voice.leave(userId)
        }
      }, TIMINGS.reconnectGraceMs)
      this.voiceOrphanTimers.set(userId, timer)
    }

    if (set.size > 0) {
      // Другие устройства всё ещё в сети — для остальных ничего не изменилось.
      this.log.info(`${s.nickname}: осталось устройств в сети — ${set.size}`)
      return
    }
    this.byUser.delete(userId)

    // Намеренный выход — сразу; обрыв — даём время переподключиться.
    const graceful = code === CloseCode.Normal || code === CloseCode.Kicked || this.closing
    const finish = (): void => {
      this.pendingLeave.delete(userId)
      this.clearVoiceOrphan(userId)
      this.voiceOwner.delete(userId)
      this.voice.leave(userId)
      try {
        this.db.touchUser(userId)
      } catch (err) {
        this.log.warn('Не удалось обновить last_seen', err)
      }
      this.broadcast('user-left', { userId })
      this.onOnlineChange(this.onlineCount)
      this.log.info(`${s.nickname} вышел(а)`)
    }
    if (graceful) {
      finish()
    } else {
      const timer = setTimeout(finish, TIMINGS.reconnectGraceMs)
      this.pendingLeave.set(userId, { timer, nickname: s.nickname, isAdmin: s.isAdmin })
    }
  }

  private clearVoiceOrphan(userId: string): void {
    const t = this.voiceOrphanTimers.get(userId)
    if (t) clearTimeout(t)
    this.voiceOrphanTimers.delete(userId)
  }

  private checkAlive(): void {
    for (const s of this.sessions) {
      if (!s.isAlive) {
        this.log.warn(`${s.label}: нет ответа на ping, разрываю`)
        s.ws.terminate()
        continue
      }
      s.isAlive = false
      try {
        s.ws.ping()
      } catch {
        /* сокет уже закрывается */
      }
    }
  }

  /* ======================= рассылка ======================= */

  private sessionsOf(userId: string): Iterable<ClientSession> {
    return this.byUser.get(userId) ?? []
  }

  broadcast<E extends EventType>(t: E, d: EventMap[E], except?: ClientSession): void {
    for (const set of this.byUser.values()) {
      for (const s of set) if (s !== except) s.event(t, d)
    }
  }

  /** Событие всем устройствам одного участника. */
  private sendToUser<E extends EventType>(userId: string, t: E, d: EventMap[E], except?: ClientSession): void {
    for (const s of this.sessionsOf(userId)) if (s !== except) s.event(t, d)
  }

  /** Событие тем, кто видит канал: всем для общего канала, двум участникам — для личного. */
  private sendToChannel<E extends EventType>(channel: Channel, t: E, d: EventMap[E], except?: ClientSession): void {
    if (channel.type !== 'dm') {
      this.broadcast(t, d, except)
      return
    }
    for (const userId of channel.members ?? []) this.sendToUser(userId, t, d, except)
  }

  /** Список каналов у каждого свой (личные каналы) — рассылаем поимённо. */
  private broadcastChannels(): void {
    const shared = this.db.listChannels()
    for (const [userId, set] of this.byUser) {
      const channels = [...shared, ...this.db.listDmChannels(userId)]
      for (const s of set) s.event('channels-updated', { channels })
    }
  }

  /** Закрывает все подключения с уведомлением. */
  shutdown(reason: string): void {
    this.closing = true
    if (this.heartbeat) clearInterval(this.heartbeat)
    for (const p of this.pendingLeave.values()) clearTimeout(p.timer)
    this.pendingLeave.clear()
    for (const t of this.voiceOrphanTimers.values()) clearTimeout(t)
    this.voiceOrphanTimers.clear()
    this.voice.closeAll()
    this.broadcast('server-closing', { reason })
    for (const s of this.sessions) s.close(CloseCode.ServerShutdown, 'server shutdown')
  }

  /* ======================= пользователи ======================= */

  private isOnline(userId: string): boolean {
    return this.byUser.has(userId) || this.pendingLeave.has(userId)
  }

  private isAdminUser(userId: string): boolean {
    for (const s of this.sessionsOf(userId)) return s.isAdmin
    return this.pendingLeave.get(userId)?.isAdmin ?? this.db.getAccount(userId)?.isAdmin ?? false
  }

  private toUserInfo(u: StoredUser, roles?: Map<string, string[]>): UserInfo {
    return {
      id: u.id,
      nickname: u.nickname,
      avatar: u.avatar,
      online: this.isOnline(u.id),
      isAdmin: this.isAdminUser(u.id),
      status: u.status,
      roles: roles ? (roles.get(u.id) ?? []) : this.db.rolesOf(u.id)
    }
  }

  private userInfo(userId: string): UserInfo {
    const u = this.db.getUser(userId)
    if (!u) throw new RequestError(ErrorCode.NotFound, 'Пользователь не найден')
    return this.toUserInfo(u)
  }

  /** Делает ник уникальным среди тех, кто сейчас в сети: «Вася» → «Вася (2)». */
  private uniqueNickname(wanted: string, selfId: string): string {
    const taken = new Set<string>()
    for (const [id, set] of this.byUser) if (id !== selfId) for (const s of set) taken.add(s.nickname.toLowerCase())
    for (const [id, p] of this.pendingLeave) if (id !== selfId) taken.add(p.nickname.toLowerCase())
    if (!taken.has(wanted.toLowerCase())) return wanted
    for (let i = 2; i < 100; i++) {
      const suffix = ` (${i})`
      const candidate = wanted.slice(0, LIMITS.nicknameLength - suffix.length) + suffix
      if (!taken.has(candidate.toLowerCase())) return candidate
    }
    return wanted.slice(0, LIMITS.nicknameLength - 7) + ` (${Date.now() % 10000})`
  }

  private snapshot(s: ClientSession): ServerSnapshot {
    const roles = this.db.rolesOfAll()
    const users = this.db.listUsers(200, this.accountsMode).map((u) => this.toUserInfo(u, roles))
    const channels = this.db.channelsFor(s.userId!)
    return {
      serverName: this.cfg.serverName,
      serverVersion: this.cfg.version,
      channels,
      users,
      you: this.userInfo(s.userId!),
      roles: this.db.listRoles(),
      statusPresets: this.db.statusPresets(),
      unread: this.db.unreadFor(s.userId!, channels),
      pushKey: this.push.publicKey,
      voiceStates: this.voice.states(),
      voiceError: this.sfu.error,
      fileToken: s.fileToken,
      maxUploadBytes: this.files.maxUploadBytes,
      account: this.accountsMode ? { login: this.db.getAccount(s.userId!)?.login ?? '' } : null
    }
  }

  /* ======================= обработчики ======================= */

  private isPasswordLocked(ip: string): boolean {
    const f = this.passwordFails.get(ip)
    if (!f) return false
    if (Date.now() - f.firstAt > PASSWORD_LOCK_MS) {
      this.passwordFails.delete(ip)
      return false
    }
    return f.count >= MAX_PASSWORD_FAILS
  }

  private notePasswordFail(ip: string): void {
    const now = Date.now()
    const f = this.passwordFails.get(ip)
    if (!f || now - f.firstAt > PASSWORD_LOCK_MS) this.passwordFails.set(ip, { count: 1, firstAt: now })
    else f.count++
    if (this.passwordFails.size > 10000) this.passwordFails.clear()
  }

  private get accountsMode(): boolean {
    return this.cfg.adminLogin.length > 0
  }

  private requireAccounts(): ZvonDb {
    if (!this.accountsMode) throw new RequestError(ErrorCode.BadRequest, 'На этом сервере нет аккаунтов')
    return this.db
  }

  /** Проверка логина и пароля. Ответ одинаково медленный, есть логин или нет. */
  private async authenticate(s: ClientSession, d: RequestMap['hello']): Promise<StoredAccount> {
    if (!d.login) {
      s.close(CloseCode.AuthFailed, 'login required')
      throw new RequestError(ErrorCode.WrongPassword, 'На этом сервере вход по логину и паролю. Обновите приложение.')
    }
    const account = this.db.getAccountByLogin(d.login)
    const ok = await verifyPassword(d.password, account?.passwordHash ?? DUMMY_HASH)
    if (!account || !ok) {
      this.notePasswordFail(s.remoteAddress)
      this.log.warn(`${s.label}: неверный логин или пароль (${d.login})`)
      await new Promise((r) => setTimeout(r, 700))
      s.close(CloseCode.AuthFailed, 'wrong password')
      throw new RequestError(ErrorCode.WrongPassword, 'Неверный логин или пароль')
    }
    if (account.disabled) {
      s.close(CloseCode.AuthFailed, 'disabled')
      throw new RequestError(ErrorCode.Forbidden, 'Аккаунт отключён администратором')
    }
    return account
  }

  private async handleHello(s: ClientSession, d: RequestMap['hello']): Promise<ServerSnapshot> {
    if (s.authenticated) throw new RequestError(ErrorCode.BadRequest, 'Повторный hello')

    if (d.protocol !== PROTOCOL_VERSION) {
      s.close(CloseCode.AuthFailed, 'version mismatch')
      throw new RequestError(
        ErrorCode.VersionMismatch,
        `Версии не совпадают: у вас протокол ${d.protocol}, у хоста ${PROTOCOL_VERSION}. Обновите приложение.`
      )
    }
    if ((this.cfg.password || this.accountsMode) && this.isPasswordLocked(s.remoteAddress)) {
      s.close(CloseCode.AuthFailed, 'too many attempts')
      throw new RequestError(ErrorCode.WrongPassword, 'Слишком много неверных паролей. Попробуйте через 15 минут.')
    }
    const account = this.accountsMode ? await this.authenticate(s, d) : null
    if (!account && this.cfg.password && !secretEquals(d.password, this.cfg.password)) {
      this.notePasswordFail(s.remoteAddress)
      this.log.warn(`${s.label}: неверный пароль`)
      // Небольшая задержка усложняет перебор пароля.
      await new Promise((r) => setTimeout(r, 700))
      s.close(CloseCode.AuthFailed, 'wrong password')
      throw new RequestError(ErrorCode.WrongPassword, 'Неверный пароль сервера')
    }
    if (this.closing) throw new RequestError(ErrorCode.Internal, 'Сервер останавливается')
    if (this.banned.has(account?.id ?? d.clientId)) {
      s.close(CloseCode.AuthFailed, 'banned')
      throw new RequestError(ErrorCode.Forbidden, 'Хост заблокировал вас на этом сервере до его перезапуска')
    }

    // С аккаунтами пользователь — это аккаунт (одинаковый на всех устройствах), без них — устройство.
    const userId = account?.id ?? d.clientId
    const isAdmin = Boolean(account?.isAdmin || (this.cfg.adminToken && d.adminToken && secretEquals(d.adminToken, this.cfg.adminToken)))

    const others = this.byUser.get(userId)
    const pending = this.pendingLeave.get(userId)
    if (pending) {
      clearTimeout(pending.timer)
      this.pendingLeave.delete(userId)
    }
    const returning = Boolean(others?.size || pending)

    // Ник аккаунта уникален (проверяется при смене), остальным уникальность обеспечиваем суффиксом.
    const nickname = account ? account.nickname : this.uniqueNickname(d.nickname, userId)
    this.db.upsertUser(userId, nickname)
    s.userId = userId
    s.nickname = nickname
    s.isAdmin = isAdmin
    s.fileToken = this.files.issueToken(userId)
    if (s.helloTimer) {
      clearTimeout(s.helloTimer)
      s.helloTimer = null
    }
    if (others) others.add(s)
    else this.byUser.set(userId, new Set([s]))

    const info = this.userInfo(userId)
    if (returning) this.broadcast('user-updated', { user: info }, s)
    else this.broadcast('user-joined', { user: info }, s)
    this.onOnlineChange(this.onlineCount)
    const devices = this.byUser.get(userId)!.size
    this.log.info(
      `${s.label} вошёл(а)${isAdmin ? ' как администратор' : ''}${returning ? ' (переподключение)' : ''}${devices > 1 ? `, устройств: ${devices}` : ''}`
    )

    return this.snapshot(s)
  }

  /** Голос ведёт то устройство, которое вошло в канал последним; остальные устройства участника из голоса выходят. */
  private async voiceJoin(s: ClientSession, d: RequestMap['voice-join']): Promise<ResponseMap['voice-join']> {
    const userId = s.userId!
    const owner = this.voiceOwner.get(userId)
    this.clearVoiceOrphan(userId)
    if (owner && owner !== s && this.sessions.has(owner)) {
      owner.event('voice-taken', { reason: 'Вы вошли в голосовой канал с другого устройства' })
    }
    this.voiceOwner.set(userId, s)
    return this.voice.join(userId, d)
  }

  /** Канал, в который участник может писать и читать: общий текстовый или свой личный. */
  private textChannelFor(channelId: string, userId: string): Channel {
    const ch = this.db.getChannel(channelId)
    if (!ch) throw new RequestError(ErrorCode.NotFound, 'Канал не найден')
    if (ch.type === 'voice') throw new RequestError(ErrorCode.BadRequest, 'Это не текстовый канал')
    if (ch.type === 'dm' && !ch.members?.includes(userId)) throw new RequestError(ErrorCode.Forbidden, 'Это чужая переписка')
    return ch
  }

  /** Находит упоминания @ник и @everyone/@все в тексте. */
  private extractMentions(content: string): string[] {
    const lower = content.toLowerCase()
    if (!lower.includes('@')) return []
    const found = new Set<string>()
    if (/(^|[^\p{L}\p{N}_])@(everyone|все)(?![\p{L}\p{N}_])/u.test(lower)) found.add('everyone')
    // Сначала длинные ники, чтобы «@Вася Пупкин» не совпал с «@Вася».
    const users = this.db.listUsers().sort((a, b) => b.nickname.length - a.nickname.length)
    let rest = lower
    for (const u of users) {
      const re = new RegExp(`(^|[^\\p{L}\\p{N}_])@${escapeRegExp(u.nickname.toLowerCase())}(?![\\p{L}\\p{N}_])`, 'u')
      if (re.test(rest)) {
        found.add(u.id)
        rest = rest.replace(re, '$1')
      }
    }
    return [...found]
  }

  private handleSend(s: ClientSession, d: RequestMap['msg-send']): ResponseMap['msg-send'] {
    const channel = this.textChannelFor(d.channelId, s.userId!)
    const content = d.content.replace(/\s+$/u, '')
    let replyTo: number | null = null
    if (d.replyTo) {
      const original = this.db.getMessage(d.replyTo)
      if (!original || original.channelId !== channel.id) throw new RequestError(ErrorCode.NotFound, 'Сообщение, на которое вы отвечаете, не найдено')
      replyTo = original.id
    }
    let message: Message
    try {
      message = this.db.insertMessage(
        {
          channelId: channel.id,
          authorId: s.userId!,
          authorName: s.nickname,
          content,
          mentions: this.extractMentions(content),
          replyTo,
          createdAt: Date.now()
        },
        [...new Set(d.attachments ?? [])]
      )
    } catch (err) {
      if ((err as Error).message === 'ATTACHMENTS_INVALID') {
        throw new RequestError(ErrorCode.BadRequest, 'Вложения не найдены или уже отправлены. Загрузите файлы заново.')
      }
      throw err
    }
    // Своё сообщение прочитано: другие устройства автора не должны увидеть его непрочитанным.
    this.db.markRead(s.userId!, channel.id, message.id)
    this.sendToUser(s.userId!, 'channel-read', { channelId: channel.id, lastReadId: message.id }, s)
    this.sendToChannel(channel, 'msg-new', { message }, s)
    this.notifyPush(channel, message)
    return { message: { ...message, nonce: d.nonce } }
  }

  /** Push тем, кого сообщение касается лично: собеседнику в личке, упомянутым и автору исходного сообщения. */
  private notifyPush(channel: Channel, message: Message): void {
    if (!this.push.publicKey) return
    const targets = new Set<string>()
    if (channel.type === 'dm') for (const id of channel.members ?? []) targets.add(id)
    else {
      for (const id of message.mentions) {
        if (id === 'everyone') for (const u of this.db.listUsers(200, this.accountsMode)) targets.add(u.id)
        else targets.add(id)
      }
      if (message.replyTo && !message.replyTo.deleted) targets.add(message.replyTo.authorId)
    }
    targets.delete(message.authorId)
    if (targets.size === 0) return
    const body = message.content.trim()
      ? message.content.length > PUSH_BODY_MAX
        ? `${message.content.slice(0, PUSH_BODY_MAX)}…`
        : message.content
      : message.attachments.length === 1
        ? `📎 ${message.attachments[0].name}`
        : `📎 Файлов: ${message.attachments.length}`
    const title = channel.type === 'dm' ? message.authorName : `${message.authorName} в #${channel.name}`
    this.push.notify([...targets], { title, body, channelId: channel.id, messageId: message.id, tag: `zvon-${channel.id}` })
  }

  private handleEdit(s: ClientSession, d: RequestMap['msg-edit']): ResponseMap['msg-edit'] {
    const existing = this.db.getMessage(d.messageId)
    if (!existing) throw new RequestError(ErrorCode.NotFound, 'Сообщение не найдено')
    if (existing.authorId !== s.userId) throw new RequestError(ErrorCode.Forbidden, 'Можно редактировать только свои сообщения')
    const channel = this.textChannelFor(existing.channelId, s.userId!)
    const content = d.content.replace(/\s+$/u, '')
    const message = this.db.updateMessage(d.messageId, content, this.extractMentions(content))
    if (!message) throw new RequestError(ErrorCode.NotFound, 'Сообщение не найдено')
    this.sendToChannel(channel, 'msg-updated', { message }, s)
    return { message }
  }

  private handleDelete(s: ClientSession, d: RequestMap['msg-delete']): ResponseMap['msg-delete'] {
    const existing = this.db.getMessage(d.messageId)
    if (!existing) throw new RequestError(ErrorCode.NotFound, 'Сообщение не найдено')
    const channel = this.db.getChannel(existing.channelId)
    const own = existing.authorId === s.userId
    // В личной переписке администратор чужое не удаляет.
    if (!own && (!s.isAdmin || channel?.type === 'dm')) {
      throw new RequestError(ErrorCode.Forbidden, 'Можно удалять только свои сообщения')
    }
    this.files.removeFromDisk(this.db.deleteMessage(d.messageId))
    if (channel) this.sendToChannel(channel, 'msg-deleted', { messageId: d.messageId, channelId: existing.channelId }, s)
    this.log.info(`${s.label} удалил(а) сообщение ${d.messageId}`)
    return { messageId: d.messageId }
  }

  private handleHistory(s: ClientSession, d: RequestMap['msg-history']): ResponseMap['msg-history'] {
    this.textChannelFor(d.channelId, s.userId!)
    const page = this.db.history(d.channelId, d.before, d.limit ?? LIMITS.historyPage)
    return { channelId: d.channelId, ...page }
  }

  private handleRead(s: ClientSession, d: RequestMap['msg-read']): ResponseMap['msg-read'] {
    this.textChannelFor(d.channelId, s.userId!)
    const before = this.db.lastReadId(s.userId!, d.channelId)
    const lastReadId = this.db.markRead(s.userId!, d.channelId, d.messageId)
    if (lastReadId !== before) this.sendToUser(s.userId!, 'channel-read', { channelId: d.channelId, lastReadId }, s)
    return {}
  }

  private handleSearch(s: ClientSession, d: RequestMap['msg-search']): ResponseMap['msg-search'] {
    const visible = this.db.channelsFor(s.userId!).filter((c) => c.type !== 'voice')
    const channels = d.channelId ? visible.filter((c) => c.id === d.channelId) : visible
    if (d.channelId && channels.length === 0) throw new RequestError(ErrorCode.NotFound, 'Канал не найден')
    return this.db.search(
      d.query,
      channels.map((c) => c.id),
      d.before,
      d.limit ?? LIMITS.searchPage
    )
  }

  private setStatus(s: ClientSession, d: RequestMap['status-set']): ResponseMap['status-set'] {
    this.db.setUserStatus(s.userId!, d.text)
    const user = this.userInfo(s.userId!)
    this.broadcast('user-updated', { user }, s)
    return { user }
  }

  private openDm(s: ClientSession, d: RequestMap['dm-open']): ResponseMap['dm-open'] {
    if (d.userId === s.userId) throw new RequestError(ErrorCode.BadRequest, 'Это вы сами')
    if (!this.db.getUser(d.userId)) throw new RequestError(ErrorCode.NotFound, 'Пользователь не найден')
    const { channel, created } = this.db.openDm(s.userId!, d.userId)
    if (created) {
      // Обоим участникам — свежие списки каналов (у каждого появился новый личный канал).
      for (const userId of channel.members ?? []) {
        const channels = this.db.channelsFor(userId)
        this.sendToUser(userId, 'channels-updated', { channels })
      }
    }
    return { channel }
  }

  private handleProfile(s: ClientSession, d: RequestMap['profile-update']): ResponseMap['profile-update'] {
    if (d.avatar !== undefined) {
      if (d.avatar !== null) {
        const f = this.db.getFile(d.avatar)
        if (!f || f.kind !== 'avatar' || f.uploaderId !== s.userId) {
          throw new RequestError(ErrorCode.BadRequest, 'Аватарка не найдена — загрузите её заново')
        }
      }
      const prev = this.db.setUserAvatar(s.userId!, d.avatar)
      if (prev && prev !== d.avatar) this.files.deleteIds([prev])
    }
    let nickname: string
    if (this.accountsMode) {
      if (this.db.nicknameTaken(d.nickname, s.userId!, true)) throw new RequestError(ErrorCode.BadRequest, 'Этот ник уже занят')
      nickname = d.nickname
    } else {
      nickname = this.uniqueNickname(d.nickname, s.userId!)
    }
    this.db.upsertUser(s.userId!, nickname)
    for (const other of this.sessionsOf(s.userId!)) other.nickname = nickname
    const user = this.userInfo(s.userId!)
    this.broadcast('user-updated', { user }, s)
    return { user }
  }

  /* ======================= панель хоста ======================= */

  private async adminStats(): Promise<AdminStats> {
    const [sfuStats, voiceStats] = await Promise.all([this.sfu.stats(), this.voice.userStats()])
    const counts = this.voice.counts()
    const users = [...this.sessions]
      .filter((s) => s.authenticated)
      .map((s) => {
        const isVoice = this.voiceOwner.get(s.userId!) === s
        const vs = isVoice ? voiceStats.get(s.userId!) : undefined
        return {
          userId: s.userId!,
          nickname: s.nickname,
          ip: s.remoteAddress,
          isAdmin: s.isAdmin,
          voiceChannelId: isVoice ? this.voice.channelOf(s.userId!) : null,
          sendKbps: vs?.sendKbps ?? 0,
          recvKbps: vs?.recvKbps ?? 0,
          producers: vs?.producers ?? 0,
          consumers: vs?.consumers ?? 0,
          connectedAt: s.connectedAt
        }
      })
    return {
      uptimeSec: Math.round((Date.now() - this.startedAt) / 1000),
      memoryMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
      users,
      sfu: {
        available: this.sfu.available,
        error: this.sfu.error,
        cpuPercent: sfuStats.cpuPercent,
        rooms: counts.rooms,
        producers: counts.producers,
        consumers: counts.consumers,
        sendKbps: users.reduce((a, u) => a + u.sendKbps, 0),
        recvKbps: users.reduce((a, u) => a + u.recvKbps, 0),
        rtcPort: this.cfg.rtcPort,
        listenIps: this.sfu.listenIps
      },
      files: { totalBytes: this.db.totalFilesSize() },
      settings: { ...this.settings },
      banned: [...this.banned].map(([userId, nickname]) => ({ userId, nickname }))
    }
  }

  private async updateSettings(d: RequestMap['admin-settings']): Promise<ResponseMap['admin-settings']> {
    const next: AdminSettings = { ...this.settings, ...Object.fromEntries(Object.entries(d).filter(([, v]) => v !== undefined)) }
    const uploadChanged = next.maxUploadMb !== this.settings.maxUploadMb
    this.settings = next
    this.db.setSetting('maxIncomingKbps', String(next.maxIncomingKbps))
    this.db.setSetting('maxOutgoingKbps', String(next.maxOutgoingKbps))
    this.db.setSetting('maxUploadMb', String(next.maxUploadMb))
    this.sfu.limits = { incoming: next.maxIncomingKbps * 1000, outgoing: next.maxOutgoingKbps * 1000 }
    await this.voice.applyLimits()
    if (uploadChanged) {
      this.cfg.maxUploadMb = next.maxUploadMb
      this.broadcast('server-settings', { maxUploadBytes: this.files.maxUploadBytes })
    }
    this.onSettingsChanged(next)
    this.log.info(`Хост изменил настройки: ${JSON.stringify(next)}`)
    return { settings: { ...next } }
  }

  private setStatusPresets(d: RequestMap['status-presets-set']): ResponseMap['status-presets-set'] {
    const presets = [...new Set(d.presets.map((p) => p.trim()).filter(Boolean))]
    this.db.setStatusPresets(presets)
    this.broadcast('status-presets', { presets })
    return { presets }
  }

  /* ======================= роли ======================= */

  private rolesEvent(): void {
    this.broadcast('roles-updated', { roles: this.db.listRoles() })
  }

  private createRole(d: RequestMap['role-create']): ResponseMap['role-create'] {
    if (this.db.listRoles().length >= LIMITS.rolesMax) throw new RequestError(ErrorCode.Forbidden, `Слишком много ролей (максимум ${LIMITS.rolesMax})`)
    const role = this.db.createRole(d.name, d.color.toLowerCase())
    this.rolesEvent()
    this.log.info(`Создана роль «${role.name}»`)
    return { role }
  }

  private updateRole(d: RequestMap['role-update']): ResponseMap['role-update'] {
    const role = this.db.updateRole(d.roleId, { name: d.name, color: d.color?.toLowerCase() })
    if (!role) throw new RequestError(ErrorCode.NotFound, 'Роль не найдена')
    this.rolesEvent()
    return { role }
  }

  private deleteRole(d: RequestMap['role-delete']): ResponseMap['role-delete'] {
    const role = this.db.getRole(d.roleId)
    if (!role) throw new RequestError(ErrorCode.NotFound, 'Роль не найдена')
    const affected = this.db.deleteRole(d.roleId)
    this.rolesEvent()
    for (const userId of affected) {
      const u = this.db.getUser(userId)
      if (u) this.broadcast('user-updated', { user: this.toUserInfo(u) })
    }
    this.log.info(`Роль «${role.name}» удалена`)
    return {}
  }

  private assignRole(d: RequestMap['role-assign']): ResponseMap['role-assign'] {
    if (!this.db.getRole(d.roleId)) throw new RequestError(ErrorCode.NotFound, 'Роль не найдена')
    if (!this.db.getUser(d.userId)) throw new RequestError(ErrorCode.NotFound, 'Пользователь не найден')
    this.db.assignRole(d.userId, d.roleId, d.assigned)
    const user = this.userInfo(d.userId)
    this.broadcast('user-updated', { user })
    return { user }
  }

  /* ======================= аккаунты ======================= */

  private accountInfo(a: StoredAccount): AccountInfo {
    return {
      id: a.id,
      login: a.login,
      nickname: a.nickname,
      isAdmin: a.isAdmin,
      disabled: a.disabled,
      online: this.isOnline(a.id),
      createdAt: a.createdAt,
      lastSeen: a.lastSeen || null
    }
  }

  private async changePassword(s: ClientSession, d: RequestMap['password-change']): Promise<ResponseMap['password-change']> {
    const account = this.requireAccounts().getAccount(s.userId!)
    if (!account) throw new RequestError(ErrorCode.NotFound, 'Аккаунт не найден')
    if (!(await verifyPassword(d.oldPassword, account.passwordHash))) {
      await new Promise((r) => setTimeout(r, 700))
      throw new RequestError(ErrorCode.WrongPassword, 'Текущий пароль указан неверно')
    }
    this.db.updateAccount(account.id, { passwordHash: await hashPassword(d.newPassword) })
    this.log.info(`${s.label} сменил(а) пароль`)
    return {}
  }

  private async createAccount(d: RequestMap['account-create']): Promise<ResponseMap['account-create']> {
    const db = this.requireAccounts()
    if (db.getAccountByLogin(d.login)) throw new RequestError(ErrorCode.BadRequest, 'Такой логин уже есть')
    if (db.listAccounts().length >= 500) throw new RequestError(ErrorCode.Forbidden, 'Слишком много аккаунтов (максимум 500)')
    const account = db.createAccount(d.login, await hashPassword(d.password), d.isAdmin)
    this.log.info(`Создан аккаунт «${account.login}»${account.isAdmin ? ' (администратор)' : ''}`)
    return { account: this.accountInfo(account) }
  }

  private async updateAccount(self: ClientSession, d: RequestMap['account-update']): Promise<ResponseMap['account-update']> {
    const db = this.requireAccounts()
    const before = db.getAccount(d.accountId)
    if (!before) throw new RequestError(ErrorCode.NotFound, 'Аккаунт не найден')
    if (d.accountId === self.userId && (d.isAdmin === false || d.disabled === true)) {
      throw new RequestError(ErrorCode.BadRequest, 'Нельзя снять права или отключить свой аккаунт')
    }
    const account = db.updateAccount(d.accountId, {
      passwordHash: d.password !== undefined ? await hashPassword(d.password) : undefined,
      isAdmin: d.isAdmin,
      disabled: d.disabled
    })!
    if (d.disabled === true) this.forceDisconnect(account.id, 'Администратор отключил ваш аккаунт', 'disabled')
    else if (d.isAdmin !== undefined && d.isAdmin !== before.isAdmin && this.byUser.has(account.id)) {
      // Права меняются со следующего входа: переподключаем, чтобы клиент получил новые.
      this.forceDisconnect(account.id, d.isAdmin ? 'Вам выданы права администратора — войдите снова' : 'Права администратора сняты — войдите снова', 'kicked')
    }
    this.log.info(`Аккаунт «${account.login}» изменён администратором`)
    return { account: this.accountInfo(account) }
  }

  private deleteAccount(self: ClientSession, d: RequestMap['account-delete']): Record<string, never> {
    const db = this.requireAccounts()
    if (d.accountId === self.userId) throw new RequestError(ErrorCode.BadRequest, 'Нельзя удалить свой аккаунт')
    const account = db.getAccount(d.accountId)
    if (!account) throw new RequestError(ErrorCode.NotFound, 'Аккаунт не найден')
    db.deleteAccount(account.id)
    this.forceDisconnect(account.id, 'Администратор удалил ваш аккаунт', 'disabled')
    this.broadcast('user-left', { userId: account.id })
    this.log.info(`Аккаунт «${account.login}» удалён`)
    return {}
  }

  /** Отключает все устройства пользователя (и убирает ожидание переподключения). */
  private forceDisconnect(userId: string, reason: string, closeReason: string): void {
    const targets = [...this.sessionsOf(userId)]
    const pending = this.pendingLeave.get(userId)
    for (const target of targets) {
      target.event('server-closing', { reason })
      target.close(CloseCode.Kicked, closeReason)
    }
    if (targets.length === 0 && pending) {
      clearTimeout(pending.timer)
      this.pendingLeave.delete(userId)
      this.clearVoiceOrphan(userId)
      this.voiceOwner.delete(userId)
      this.voice.leave(userId)
      this.broadcast('user-left', { userId })
      this.onOnlineChange(this.onlineCount)
    }
  }

  private kick(self: ClientSession, d: RequestMap['admin-kick']): Record<string, never> {
    if (d.userId === self.userId) throw new RequestError(ErrorCode.BadRequest, 'Нельзя отключить самого себя')
    const targets = [...this.sessionsOf(d.userId)]
    const pending = this.pendingLeave.get(d.userId)
    if (targets.length === 0 && !pending && !d.ban) throw new RequestError(ErrorCode.NotFound, 'Пользователь не в сети')
    if (d.ban) this.banned.set(d.userId, targets[0]?.nickname ?? pending?.nickname ?? this.db.getUser(d.userId)?.nickname ?? '?')
    this.forceDisconnect(d.userId, d.ban ? 'Хост заблокировал вас' : 'Хост отключил вас', d.ban ? 'banned' : 'kicked')
    this.log.info(`Хост ${d.ban ? 'заблокировал' : 'отключил'} ${d.userId}`)
    return {}
  }

  private createChannel(d: RequestMap['channel-create']): ResponseMap['channel-create'] {
    if (this.db.listChannels().length >= 50) throw new RequestError(ErrorCode.Forbidden, 'Слишком много каналов (максимум 50)')
    const channel = this.db.createChannel(d.name, d.type)
    this.broadcastChannels()
    return { channel }
  }

  private renameChannel(d: RequestMap['channel-rename']): ResponseMap['channel-rename'] {
    const existing = this.db.getChannel(d.channelId)
    if (!existing || existing.type === 'dm') throw new RequestError(ErrorCode.NotFound, 'Канал не найден')
    const channel = this.db.renameChannel(d.channelId, d.name)!
    this.broadcastChannels()
    return { channel }
  }

  private deleteChannel(d: RequestMap['channel-delete']): Record<string, never> {
    const ch = this.db.getChannel(d.channelId)
    if (!ch || ch.type === 'dm') throw new RequestError(ErrorCode.NotFound, 'Канал не найден')
    if (ch.type === 'text' && this.db.listChannels().filter((c) => c.type === 'text').length <= 1) {
      throw new RequestError(ErrorCode.BadRequest, 'Нельзя удалить последний текстовый канал')
    }
    if (ch.type === 'voice') this.voice.closeChannel(ch.id)
    this.files.removeFromDisk(this.db.deleteChannel(ch.id))
    this.broadcastChannels()
    this.log.info(`Канал «${ch.name}» удалён`)
    return {}
  }

  private handleTyping(s: ClientSession, d: RequestMap['typing']): ResponseMap['typing'] {
    const now = Date.now()
    // Сервер дополнительно гасит слишком частые события.
    if (now - s.lastTypingAt < TIMINGS.typingThrottleMs / 2) return {}
    s.lastTypingAt = now
    const channel = this.textChannelFor(d.channelId, s.userId!)
    this.sendToChannel(channel, 'typing', { channelId: d.channelId, userId: s.userId! }, s)
    return {}
  }
}

