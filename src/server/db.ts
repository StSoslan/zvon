import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { LIMITS } from '../shared/constants'
import type { Channel, ChannelType, FileInfo, FileKind, Message, PushSubscriptionJson, ReplyRef, Role, UnreadInfo } from '../shared/types'
import type { Logger } from './logger'

/** Миграции применяются по порядку; номер версии хранится в PRAGMA user_version. */
const MIGRATIONS: string[] = [
  `
  CREATE TABLE channels (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    type       TEXT NOT NULL CHECK (type IN ('text', 'voice')),
    position   INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE users (
    id         TEXT PRIMARY KEY,
    nickname   TEXT NOT NULL,
    avatar     TEXT,
    created_at INTEGER NOT NULL,
    last_seen  INTEGER NOT NULL
  );
  CREATE TABLE messages (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id  TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    author_id   TEXT NOT NULL,
    author_name TEXT NOT NULL,
    content     TEXT NOT NULL,
    mentions    TEXT NOT NULL DEFAULT '[]',
    created_at  INTEGER NOT NULL,
    edited_at   INTEGER
  );
  CREATE INDEX idx_messages_channel ON messages (channel_id, id);
  `,
  `
  CREATE TABLE files (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    mime        TEXT NOT NULL,
    size        INTEGER NOT NULL,
    kind        TEXT NOT NULL,
    width       INTEGER,
    height      INTEGER,
    duration    REAL,
    thumb_id    TEXT,
    is_thumb    INTEGER NOT NULL DEFAULT 0,
    uploader_id TEXT NOT NULL,
    message_id  INTEGER,
    created_at  INTEGER NOT NULL
  );
  CREATE INDEX idx_files_message ON files (message_id);
  CREATE INDEX idx_files_orphans ON files (message_id, created_at);
  ALTER TABLE messages ADD COLUMN attachments TEXT NOT NULL DEFAULT '[]';
  `,
  `
  CREATE TABLE settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,
  `
  CREATE TABLE accounts (
    id            TEXT PRIMARY KEY,
    login         TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    is_admin      INTEGER NOT NULL DEFAULT 0,
    disabled      INTEGER NOT NULL DEFAULT 0,
    created_at    INTEGER NOT NULL
  );
  `,
  // Ответы, статусы, роли, личные каналы, прочитанное, push и полнотекстовый поиск.
  `
  ALTER TABLE messages ADD COLUMN reply_to INTEGER;
  ALTER TABLE users ADD COLUMN status TEXT;
  CREATE TABLE roles (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    color      TEXT NOT NULL,
    position   INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE user_roles (
    user_id TEXT NOT NULL,
    role_id TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    PRIMARY KEY (user_id, role_id)
  );
  CREATE TABLE channel_members (
    channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    user_id    TEXT NOT NULL,
    PRIMARY KEY (channel_id, user_id)
  );
  CREATE INDEX idx_channel_members_user ON channel_members (user_id);
  CREATE TABLE reads (
    user_id      TEXT NOT NULL,
    channel_id   TEXT NOT NULL,
    last_read_id INTEGER NOT NULL,
    PRIMARY KEY (user_id, channel_id)
  );
  CREATE TABLE push_subscriptions (
    endpoint   TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL,
    p256dh     TEXT NOT NULL,
    auth       TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX idx_push_user ON push_subscriptions (user_id);
  CREATE VIRTUAL TABLE messages_fts USING fts5(content, content='messages', content_rowid='id', tokenize='unicode61 remove_diacritics 2');
  INSERT INTO messages_fts(rowid, content) SELECT id, content FROM messages;
  CREATE TRIGGER messages_fts_ai AFTER INSERT ON messages BEGIN
    INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
  END;
  CREATE TRIGGER messages_fts_ad AFTER DELETE ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.id, old.content);
  END;
  CREATE TRIGGER messages_fts_au AFTER UPDATE OF content ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.id, old.content);
    INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
  END;
  `
]

/** SQLite не умеет менять CHECK-ограничение: тип 'dm' разрешаем, пересоздавая таблицу каналов. */
const CHANNELS_WITH_DM = `
  CREATE TABLE channels_new (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    type       TEXT NOT NULL CHECK (type IN ('text', 'voice', 'dm')),
    position   INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  INSERT INTO channels_new SELECT id, name, type, position, created_at FROM channels;
  DROP TABLE channels;
  ALTER TABLE channels_new RENAME TO channels;
`

/** Готовые статусы, пока администратор не задал свои. */
export const DEFAULT_STATUS_PRESETS = ['Отошёл', 'Скоро вернусь', 'Не беспокоить', 'На работе', 'Играю']

interface MessageRow {
  id: number
  channel_id: string
  author_id: string
  author_name: string
  content: string
  mentions: string
  created_at: number
  edited_at: number | null
  attachments: string
  reply_to: number | null
}

interface FileRow {
  id: string
  name: string
  mime: string
  size: number
  kind: FileKind
  width: number | null
  height: number | null
  duration: number | null
  thumb_id: string | null
  is_thumb: number
  uploader_id: string
  message_id: number | null
  created_at: number
}

/** Запись о файле со служебными полями (для проверок прав и удаления). */
export interface StoredFile extends FileInfo {
  isThumb: boolean
  uploaderId: string
  messageId: number | null
  createdAt: number
}

export type NewFile = Omit<StoredFile, 'messageId' | 'thumbId' | 'createdAt'>

function rowToFile(r: FileRow): StoredFile {
  return {
    id: r.id,
    name: r.name,
    mime: r.mime,
    size: r.size,
    kind: r.kind,
    width: r.width,
    height: r.height,
    duration: r.duration,
    thumbId: r.thumb_id,
    isThumb: r.is_thumb === 1,
    uploaderId: r.uploader_id,
    messageId: r.message_id,
    createdAt: r.created_at
  }
}

export function publicFile(f: StoredFile): FileInfo {
  return {
    id: f.id,
    name: f.name,
    mime: f.mime,
    size: f.size,
    kind: f.kind,
    width: f.width,
    height: f.height,
    duration: f.duration,
    thumbId: f.thumbId
  }
}

function parseIds(json: string): string[] {
  try {
    const v: unknown = JSON.parse(json)
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

interface ChannelRow {
  id: string
  name: string
  type: ChannelType
  position: number
}

/** Аккаунт вместе с профилем (ник и аватарка — в users с тем же id). */
export interface StoredAccount {
  id: string
  login: string
  passwordHash: string
  isAdmin: boolean
  disabled: boolean
  createdAt: number
  nickname: string
  lastSeen: number | null
}

interface AccountRow {
  id: string
  login: string
  password_hash: string
  is_admin: number
  disabled: number
  created_at: number
  nickname: string | null
  last_seen: number | null
}

function rowToAccount(r: AccountRow): StoredAccount {
  return {
    id: r.id,
    login: r.login,
    passwordHash: r.password_hash,
    isAdmin: r.is_admin === 1,
    disabled: r.disabled === 1,
    createdAt: r.created_at,
    nickname: r.nickname ?? r.login,
    lastSeen: r.last_seen
  }
}

const ACCOUNT_SELECT = `SELECT a.*, u.nickname, u.last_seen FROM accounts a LEFT JOIN users u ON u.id = a.id`

export interface StoredUser {
  id: string
  nickname: string
  avatar: string | null
  status: string | null
  lastSeen: number
}

interface UserRow {
  id: string
  nickname: string
  avatar: string | null
  status: string | null
  last_seen: number
}

function rowToUser(r: UserRow): StoredUser {
  return { id: r.id, nickname: r.nickname, avatar: r.avatar, status: r.status, lastSeen: r.last_seen }
}

function rowToMessage(r: MessageRow, files: Map<string, StoredFile>, replies: Map<number, ReplyRef>): Message {
  let mentions: string[] = []
  try {
    const parsed: unknown = JSON.parse(r.mentions)
    if (Array.isArray(parsed)) mentions = parsed.filter((x): x is string => typeof x === 'string')
  } catch {
    /* повреждённое поле — считаем, что упоминаний нет */
  }
  return {
    id: r.id,
    channelId: r.channel_id,
    authorId: r.author_id,
    authorName: r.author_name,
    content: r.content,
    mentions,
    attachments: parseIds(r.attachments)
      .map((id) => files.get(id))
      .filter((f): f is StoredFile => Boolean(f))
      .map(publicFile),
    replyTo: r.reply_to === null ? null : (replies.get(r.reply_to) ?? { id: r.reply_to, authorId: '', authorName: '', content: '', attachments: 0, deleted: true }),
    createdAt: r.created_at,
    editedAt: r.edited_at
  }
}

/** Превращает строку поиска в запрос FTS5: каждое слово — префикс, все слова обязательны. */
function ftsQuery(raw: string): string | null {
  const words = raw
    .split(/\s+/u)
    .map((w) => w.replace(/["*]/g, '').trim())
    .filter((w) => w.length > 0)
    .slice(0, 8)
  if (words.length === 0) return null
  return words.map((w) => `"${w}"*`).join(' ')
}

export class ZvonDb {
  private db: Database.Database

  constructor(file: string, private log: Logger) {
    this.db = new Database(file)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('foreign_keys = ON')
    this.db.pragma('synchronous = NORMAL')
    this.migrate()
    this.seedDefaults()
  }

  private migrate(): void {
    const current = this.db.pragma('user_version', { simple: true }) as number
    for (let v = current; v < MIGRATIONS.length; v++) {
      this.log.info(`Применяю миграцию БД №${v + 1}`)
      // Пятая миграция пересоздаёт таблицу каналов. Внешние ключи выключаем ЗАРАНЕЕ (внутри транзакции
      // PRAGMA не действует): иначе DROP TABLE channels каскадом удалил бы все сообщения.
      const rebuildChannels = v === 4
      if (rebuildChannels) this.db.pragma('foreign_keys = OFF')
      try {
        this.db.transaction(() => {
          this.db.exec(MIGRATIONS[v])
          if (rebuildChannels) this.db.exec(CHANNELS_WITH_DM)
          this.db.pragma(`user_version = ${v + 1}`)
        })()
      } finally {
        if (rebuildChannels) this.db.pragma('foreign_keys = ON')
      }
    }
  }

  private seedDefaults(): void {
    const count = (this.db.prepare('SELECT COUNT(*) AS n FROM channels').get() as { n: number }).n
    if (count > 0) return
    const defaults: Array<[string, ChannelType]> = [
      ['общий', 'text'],
      ['мемы', 'text'],
      ['Общий голосовой', 'voice'],
      ['Игры', 'voice']
    ]
    const insert = this.db.prepare('INSERT INTO channels (id, name, type, position, created_at) VALUES (?, ?, ?, ?, ?)')
    const now = Date.now()
    this.db.transaction(() => {
      defaults.forEach(([name, type], i) => insert.run(randomUUID(), name, type, i, now))
    })()
    this.log.info('Созданы каналы по умолчанию')
  }

  close(): void {
    try {
      this.db.close()
    } catch (err) {
      this.log.warn('Ошибка при закрытии БД', err)
    }
  }

  /* ---------- каналы ---------- */

  private rowToChannel(r: ChannelRow, members?: Map<string, string[]>): Channel {
    const ch: Channel = { id: r.id, name: r.name, type: r.type, position: r.position }
    if (r.type === 'dm') ch.members = members?.get(r.id) ?? this.channelMembers(r.id)
    return ch
  }

  /** Общие каналы сервера (без личных). */
  listChannels(): Channel[] {
    const rows = this.db
      .prepare(`SELECT id, name, type, position FROM channels WHERE type != 'dm' ORDER BY type, position, created_at`)
      .all() as ChannelRow[]
    return rows.map((r) => this.rowToChannel(r))
  }

  /** Личные каналы участника. */
  listDmChannels(userId: string): Channel[] {
    const rows = this.db
      .prepare(
        `SELECT c.id, c.name, c.type, c.position FROM channels c
         JOIN channel_members m ON m.channel_id = c.id WHERE c.type = 'dm' AND m.user_id = ? ORDER BY c.created_at`
      )
      .all(userId) as ChannelRow[]
    return rows.map((r) => this.rowToChannel(r))
  }

  /** Все каналы, которые видит участник: общие плюс его личные. */
  channelsFor(userId: string): Channel[] {
    return [...this.listChannels(), ...this.listDmChannels(userId)]
  }

  getChannel(id: string): Channel | null {
    const r = this.db.prepare('SELECT id, name, type, position FROM channels WHERE id = ?').get(id) as ChannelRow | undefined
    return r ? this.rowToChannel(r) : null
  }

  channelMembers(channelId: string): string[] {
    return (this.db.prepare('SELECT user_id FROM channel_members WHERE channel_id = ?').all(channelId) as Array<{ user_id: string }>).map(
      (r) => r.user_id
    )
  }

  isChannelMember(channelId: string, userId: string): boolean {
    return Boolean(this.db.prepare('SELECT 1 FROM channel_members WHERE channel_id = ? AND user_id = ?').get(channelId, userId))
  }

  /** Личный канал двух участников (создаётся при первом обращении). Возвращает канал и признак «только что создан». */
  openDm(a: string, b: string): { channel: Channel; created: boolean } {
    const existing = this.db
      .prepare(
        `SELECT c.id, c.name, c.type, c.position FROM channels c
         WHERE c.type = 'dm'
           AND EXISTS (SELECT 1 FROM channel_members WHERE channel_id = c.id AND user_id = ?)
           AND EXISTS (SELECT 1 FROM channel_members WHERE channel_id = c.id AND user_id = ?)
         LIMIT 1`
      )
      .get(a, b) as ChannelRow | undefined
    if (existing) return { channel: this.rowToChannel(existing), created: false }
    const id = randomUUID()
    this.db.transaction(() => {
      this.db.prepare(`INSERT INTO channels (id, name, type, position, created_at) VALUES (?, '', 'dm', 0, ?)`).run(id, Date.now())
      const ins = this.db.prepare('INSERT INTO channel_members (channel_id, user_id) VALUES (?, ?)')
      ins.run(id, a)
      ins.run(id, b)
    })()
    return { channel: this.getChannel(id)!, created: true }
  }

  private nextPosition(type: ChannelType): number {
    const r = this.db.prepare('SELECT COALESCE(MAX(position), -1) AS p FROM channels WHERE type = ?').get(type) as { p: number }
    return r.p + 1
  }

  createChannel(name: string, type: ChannelType): Channel {
    const id = randomUUID()
    this.db
      .prepare('INSERT INTO channels (id, name, type, position, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, name, type, this.nextPosition(type), Date.now())
    return this.getChannel(id)!
  }

  renameChannel(id: string, name: string): Channel | null {
    this.db.prepare('UPDATE channels SET name = ? WHERE id = ?').run(name, id)
    return this.getChannel(id)
  }

  /** Удаляет канал вместе с сообщениями и возвращает их файлы (для удаления с диска). */
  deleteChannel(id: string): StoredFile[] {
    const run = this.db.transaction(() => {
      const files = (
        this.db.prepare('SELECT f.* FROM files f JOIN messages m ON f.message_id = m.id WHERE m.channel_id = ?').all(id) as FileRow[]
      ).map(rowToFile)
      if (files.length) {
        const ph = files.map(() => '?').join(',')
        this.db.prepare(`DELETE FROM files WHERE id IN (${ph})`).run(...files.map((f) => f.id))
      }
      this.db.prepare('DELETE FROM messages WHERE channel_id = ?').run(id)
      this.db.prepare('DELETE FROM reads WHERE channel_id = ?').run(id)
      this.db.prepare('DELETE FROM channels WHERE id = ?').run(id)
      return files
    })
    return run()
  }

  /** Меняет канал местами с соседним того же типа. */
  moveChannel(id: string, direction: 'up' | 'down'): void {
    const ch = this.getChannel(id)
    if (!ch) return
    const list = this.listChannels().filter((c) => c.type === ch.type)
    const i = list.findIndex((c) => c.id === id)
    const j = direction === 'up' ? i - 1 : i + 1
    if (i < 0 || j < 0 || j >= list.length) return
    // Нормализуем позиции и меняем две местами.
    const ordered = [...list]
    ;[ordered[i], ordered[j]] = [ordered[j], ordered[i]]
    const upd = this.db.prepare('UPDATE channels SET position = ? WHERE id = ?')
    this.db.transaction(() => ordered.forEach((c, pos) => upd.run(pos, c.id)))()
  }

  /* ---------- настройки сервера ---------- */

  getSetting(key: string): string | null {
    const r = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined
    return r?.value ?? null
  }

  setSetting(key: string, value: string): void {
    this.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value)
  }

  statusPresets(): string[] {
    const raw = this.getSetting('statusPresets')
    if (raw === null) return [...DEFAULT_STATUS_PRESETS]
    try {
      const v: unknown = JSON.parse(raw)
      return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [...DEFAULT_STATUS_PRESETS]
    } catch {
      return [...DEFAULT_STATUS_PRESETS]
    }
  }

  setStatusPresets(presets: string[]): void {
    this.setSetting('statusPresets', JSON.stringify(presets))
  }

  /* ---------- пользователи ---------- */

  upsertUser(id: string, nickname: string): StoredUser {
    const now = Date.now()
    this.db
      .prepare(
        `INSERT INTO users (id, nickname, avatar, created_at, last_seen) VALUES (?, ?, NULL, ?, ?)
         ON CONFLICT(id) DO UPDATE SET nickname = excluded.nickname, last_seen = excluded.last_seen`
      )
      .run(id, nickname, now, now)
    return this.getUser(id)!
  }

  touchUser(id: string): void {
    this.db.prepare('UPDATE users SET last_seen = ? WHERE id = ?').run(Date.now(), id)
  }

  getUser(id: string): StoredUser | null {
    const r = this.db.prepare('SELECT id, nickname, avatar, status, last_seen FROM users WHERE id = ?').get(id) as UserRow | undefined
    return r ? rowToUser(r) : null
  }

  setUserStatus(id: string, status: string | null): void {
    this.db.prepare('UPDATE users SET status = ? WHERE id = ?').run(status, id)
  }

  /**
   * Недавние пользователи (для списка участников «не в сети»).
   * accountsOnly — только владельцы аккаунтов (без гостей, входивших до включения аккаунтов).
   */
  listUsers(limit = 200, accountsOnly = false): StoredUser[] {
    const where = accountsOnly ? 'WHERE id IN (SELECT id FROM accounts)' : ''
    const rows = this.db.prepare(`SELECT id, nickname, avatar, status, last_seen FROM users ${where} ORDER BY last_seen DESC LIMIT ?`).all(limit) as UserRow[]
    return rows.map(rowToUser)
  }

  /** Ник занят другим пользователем (без учёта регистра; lower() в SQLite не знает кириллицу — сравниваем в JS). */
  nicknameTaken(nickname: string, exceptId: string, accountsOnly: boolean): boolean {
    const where = accountsOnly ? 'AND id IN (SELECT id FROM accounts)' : ''
    const wanted = nickname.toLocaleLowerCase()
    const rows = this.db.prepare(`SELECT nickname FROM users WHERE id != ? ${where}`).all(exceptId) as Array<{ nickname: string }>
    return rows.some((r) => r.nickname.toLocaleLowerCase() === wanted)
  }

  /* ---------- роли ---------- */

  listRoles(): Role[] {
    const rows = this.db.prepare('SELECT id, name, color, position FROM roles ORDER BY position, created_at').all() as Role[]
    return rows.map((r) => ({ id: r.id, name: r.name, color: r.color, position: r.position }))
  }

  getRole(id: string): Role | null {
    const r = this.db.prepare('SELECT id, name, color, position FROM roles WHERE id = ?').get(id) as Role | undefined
    return r ? { id: r.id, name: r.name, color: r.color, position: r.position } : null
  }

  createRole(name: string, color: string): Role {
    const id = randomUUID()
    const pos = (this.db.prepare('SELECT COALESCE(MAX(position), -1) AS p FROM roles').get() as { p: number }).p + 1
    this.db.prepare('INSERT INTO roles (id, name, color, position, created_at) VALUES (?, ?, ?, ?, ?)').run(id, name, color, pos, Date.now())
    return this.getRole(id)!
  }

  updateRole(id: string, patch: { name?: string; color?: string }): Role | null {
    if (patch.name !== undefined) this.db.prepare('UPDATE roles SET name = ? WHERE id = ?').run(patch.name, id)
    if (patch.color !== undefined) this.db.prepare('UPDATE roles SET color = ? WHERE id = ?').run(patch.color, id)
    return this.getRole(id)
  }

  /** Удаляет роль; возвращает участников, у которых она была (чтобы разослать обновления). */
  deleteRole(id: string): string[] {
    const users = (this.db.prepare('SELECT user_id FROM user_roles WHERE role_id = ?').all(id) as Array<{ user_id: string }>).map((r) => r.user_id)
    this.db.prepare('DELETE FROM roles WHERE id = ?').run(id)
    return users
  }

  assignRole(userId: string, roleId: string, assigned: boolean): void {
    if (assigned) this.db.prepare('INSERT OR IGNORE INTO user_roles (user_id, role_id) VALUES (?, ?)').run(userId, roleId)
    else this.db.prepare('DELETE FROM user_roles WHERE user_id = ? AND role_id = ?').run(userId, roleId)
  }

  /** Роли участника в порядке ролей сервера. */
  rolesOf(userId: string): string[] {
    return (
      this.db
        .prepare('SELECT ur.role_id FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = ? ORDER BY r.position, r.created_at')
        .all(userId) as Array<{ role_id: string }>
    ).map((r) => r.role_id)
  }

  /** Роли всех участников одним запросом: userId → id ролей. */
  rolesOfAll(): Map<string, string[]> {
    const rows = this.db
      .prepare('SELECT ur.user_id, ur.role_id FROM user_roles ur JOIN roles r ON r.id = ur.role_id ORDER BY r.position, r.created_at')
      .all() as Array<{ user_id: string; role_id: string }>
    const map = new Map<string, string[]>()
    for (const r of rows) {
      const list = map.get(r.user_id) ?? []
      list.push(r.role_id)
      map.set(r.user_id, list)
    }
    return map
  }

  /* ---------- аккаунты ---------- */

  hasAccounts(): boolean {
    return Boolean(this.db.prepare('SELECT 1 FROM accounts LIMIT 1').get())
  }

  listAccounts(): StoredAccount[] {
    return (this.db.prepare(`${ACCOUNT_SELECT} ORDER BY a.login COLLATE NOCASE`).all() as AccountRow[]).map(rowToAccount)
  }

  getAccount(id: string): StoredAccount | null {
    const r = this.db.prepare(`${ACCOUNT_SELECT} WHERE a.id = ?`).get(id) as AccountRow | undefined
    return r ? rowToAccount(r) : null
  }

  getAccountByLogin(login: string): StoredAccount | null {
    const r = this.db.prepare(`${ACCOUNT_SELECT} WHERE a.login = ? COLLATE NOCASE`).get(login) as AccountRow | undefined
    return r ? rowToAccount(r) : null
  }

  /** Создаёт аккаунт и его профиль; ник по умолчанию — логин. */
  createAccount(login: string, passwordHash: string, isAdmin: boolean): StoredAccount {
    const id = randomUUID()
    const now = Date.now()
    this.db.transaction(() => {
      this.db
        .prepare('INSERT INTO accounts (id, login, password_hash, is_admin, disabled, created_at) VALUES (?, ?, ?, ?, 0, ?)')
        .run(id, login, passwordHash, isAdmin ? 1 : 0, now)
      this.db.prepare('INSERT INTO users (id, nickname, avatar, created_at, last_seen) VALUES (?, ?, NULL, ?, 0)').run(id, login, now)
    })()
    return this.getAccount(id)!
  }

  updateAccount(id: string, patch: { passwordHash?: string; isAdmin?: boolean; disabled?: boolean }): StoredAccount | null {
    if (patch.passwordHash !== undefined) this.db.prepare('UPDATE accounts SET password_hash = ? WHERE id = ?').run(patch.passwordHash, id)
    if (patch.isAdmin !== undefined) this.db.prepare('UPDATE accounts SET is_admin = ? WHERE id = ?').run(patch.isAdmin ? 1 : 0, id)
    if (patch.disabled !== undefined) this.db.prepare('UPDATE accounts SET disabled = ? WHERE id = ?').run(patch.disabled ? 1 : 0, id)
    return this.getAccount(id)
  }

  /** Удаляет аккаунт; сообщения и профиль остаются (в истории видно имя автора). */
  deleteAccount(id: string): void {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM accounts WHERE id = ?').run(id)
      this.db.prepare('DELETE FROM user_roles WHERE user_id = ?').run(id)
      this.db.prepare('DELETE FROM push_subscriptions WHERE user_id = ?').run(id)
    })()
  }

  /* ---------- сообщения ---------- */

  /** Подтягивает вложения и цитаты для пачки сообщений несколькими запросами. */
  private toMessages(rows: MessageRow[]): Message[] {
    const ids = [...new Set(rows.flatMap((r) => parseIds(r.attachments)))]
    const files = new Map<string, StoredFile>()
    if (ids.length > 0) {
      const placeholders = ids.map(() => '?').join(',')
      const fileRows = this.db.prepare(`SELECT * FROM files WHERE id IN (${placeholders})`).all(...ids) as FileRow[]
      for (const f of fileRows) files.set(f.id, rowToFile(f))
    }
    const replyIds = [...new Set(rows.map((r) => r.reply_to).filter((x): x is number => x !== null))]
    const replies = new Map<number, ReplyRef>()
    if (replyIds.length > 0) {
      const ph = replyIds.map(() => '?').join(',')
      const refs = this.db
        .prepare(`SELECT id, author_id, author_name, content, attachments FROM messages WHERE id IN (${ph})`)
        .all(...replyIds) as Array<Pick<MessageRow, 'id' | 'author_id' | 'author_name' | 'content' | 'attachments'>>
      for (const r of refs) {
        const text = r.content.replace(/\s+/gu, ' ').trim()
        replies.set(r.id, {
          id: r.id,
          authorId: r.author_id,
          authorName: r.author_name,
          content: text.length > LIMITS.replySnippetLength ? `${text.slice(0, LIMITS.replySnippetLength)}…` : text,
          attachments: parseIds(r.attachments).length,
          deleted: false
        })
      }
    }
    return rows.map((r) => rowToMessage(r, files, replies))
  }

  /** Сохраняет сообщение и привязывает к нему вложения (только свои и ещё не привязанные). */
  insertMessage(
    m: Omit<Message, 'id' | 'editedAt' | 'nonce' | 'attachments' | 'replyTo'> & { replyTo: number | null },
    attachmentIds: string[]
  ): Message {
    const run = this.db.transaction(() => {
      const info = this.db
        .prepare(
          'INSERT INTO messages (channel_id, author_id, author_name, content, mentions, created_at, attachments, reply_to) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
        )
        .run(m.channelId, m.authorId, m.authorName, m.content, JSON.stringify(m.mentions), m.createdAt, JSON.stringify(attachmentIds), m.replyTo)
      const id = Number(info.lastInsertRowid)
      if (attachmentIds.length > 0) {
        const placeholders = attachmentIds.map(() => '?').join(',')
        const changed = this.db
          .prepare(
            `UPDATE files SET message_id = ? WHERE id IN (${placeholders}) AND uploader_id = ? AND message_id IS NULL AND is_thumb = 0 AND kind != 'avatar'`
          )
          .run(id, ...attachmentIds, m.authorId).changes
        if (changed !== attachmentIds.length) throw new Error('ATTACHMENTS_INVALID')
        // Миниатюры живут вместе с основным файлом.
        this.db
          .prepare(`UPDATE files SET message_id = ? WHERE id IN (SELECT thumb_id FROM files WHERE message_id = ? AND thumb_id IS NOT NULL)`)
          .run(id, id)
      }
      return id
    })
    const id = run()
    return this.getMessage(id)!
  }

  getMessage(id: number): Message | null {
    const r = this.db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as MessageRow | undefined
    return r ? this.toMessages([r])[0] : null
  }

  updateMessage(id: number, content: string, mentions: string[]): Message | null {
    this.db
      .prepare('UPDATE messages SET content = ?, mentions = ?, edited_at = ? WHERE id = ?')
      .run(content, JSON.stringify(mentions), Date.now(), id)
    return this.getMessage(id)
  }

  /** Удаляет сообщение и возвращает его файлы (вместе с миниатюрами), чтобы стереть их с диска. */
  deleteMessage(id: number): StoredFile[] {
    const run = this.db.transaction(() => {
      const files = (this.db.prepare('SELECT * FROM files WHERE message_id = ?').all(id) as FileRow[]).map(rowToFile)
      this.db.prepare('DELETE FROM files WHERE message_id = ?').run(id)
      this.db.prepare('DELETE FROM messages WHERE id = ?').run(id)
      return files
    })
    return run()
  }

  /** Страница истории: сообщения с id < before, в хронологическом порядке. */
  history(channelId: string, before: number | undefined, limit: number): { messages: Message[]; hasMore: boolean } {
    const rows = (
      before
        ? this.db
            .prepare('SELECT * FROM messages WHERE channel_id = ? AND id < ? ORDER BY id DESC LIMIT ?')
            .all(channelId, before, limit + 1)
        : this.db.prepare('SELECT * FROM messages WHERE channel_id = ? ORDER BY id DESC LIMIT ?').all(channelId, limit + 1)
    ) as MessageRow[]
    const hasMore = rows.length > limit
    const page = rows.slice(0, limit).reverse()
    return { messages: this.toMessages(page), hasMore }
  }

  /** Полнотекстовый поиск в указанных каналах, от новых к старым. */
  search(query: string, channelIds: string[], before: number | undefined, limit: number): { messages: Message[]; hasMore: boolean } {
    const match = ftsQuery(query)
    if (!match || channelIds.length === 0) return { messages: [], hasMore: false }
    const ph = channelIds.map(() => '?').join(',')
    let rows: MessageRow[]
    try {
      rows = this.db
        .prepare(
          `SELECT m.* FROM messages_fts f JOIN messages m ON m.id = f.rowid
           WHERE messages_fts MATCH ? AND m.channel_id IN (${ph}) AND m.id < ? ORDER BY m.id DESC LIMIT ?`
        )
        .all(match, ...channelIds, before ?? Number.MAX_SAFE_INTEGER, limit + 1) as MessageRow[]
    } catch (err) {
      // Странный запрос, который FTS не разобрал, — считаем, что ничего не нашлось.
      this.log.warn('Поиск не удался', err)
      return { messages: [], hasMore: false }
    }
    return { messages: this.toMessages(rows.slice(0, limit)), hasMore: rows.length > limit }
  }

  /* ---------- прочитанное ---------- */

  lastReadId(userId: string, channelId: string): number {
    const r = this.db.prepare('SELECT last_read_id FROM reads WHERE user_id = ? AND channel_id = ?').get(userId, channelId) as
      | { last_read_id: number }
      | undefined
    return r?.last_read_id ?? 0
  }

  /** Отмечает прочитанным до messageId (только вперёд). Возвращает новое значение. */
  markRead(userId: string, channelId: string, messageId: number): number {
    this.db
      .prepare(
        `INSERT INTO reads (user_id, channel_id, last_read_id) VALUES (?, ?, ?)
         ON CONFLICT(user_id, channel_id) DO UPDATE SET last_read_id = MAX(last_read_id, excluded.last_read_id)`
      )
      .run(userId, channelId, messageId)
    return this.lastReadId(userId, channelId)
  }

  /**
   * Непрочитанное участника по каналам (без своих сообщений). В личных каналах каждое сообщение
   * считается важным, как упоминание.
   */
  unreadFor(userId: string, channels: Channel[]): Record<string, UnreadInfo> {
    const result: Record<string, UnreadInfo> = {}
    const stmt = this.db.prepare(
      `SELECT COUNT(*) AS n, MIN(id) AS first,
              SUM(CASE WHEN mentions LIKE ? OR mentions LIKE '%"everyone"%' OR reply_to IN (SELECT id FROM messages WHERE author_id = ?) THEN 1 ELSE 0 END) AS mentions
       FROM messages WHERE channel_id = ? AND id > ? AND author_id != ?`
    )
    const mentionLike = `%"${userId.replace(/[%_]/g, '')}"%`
    for (const ch of channels) {
      if (ch.type === 'voice') continue
      const lastReadId = this.lastReadId(userId, ch.id)
      const r = stmt.get(mentionLike, userId, ch.id, lastReadId, userId) as { n: number; first: number | null; mentions: number | null }
      if (!r.n) continue
      result[ch.id] = {
        lastReadId,
        count: r.n,
        mentions: ch.type === 'dm' ? r.n : (r.mentions ?? 0),
        firstUnreadId: r.first
      }
    }
    return result
  }

  /* ---------- push-подписки ---------- */

  addPushSubscription(userId: string, sub: PushSubscriptionJson): void {
    this.db
      .prepare(
        `INSERT INTO push_subscriptions (endpoint, user_id, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth`
      )
      .run(sub.endpoint, userId, sub.keys.p256dh, sub.keys.auth, Date.now())
  }

  removePushSubscription(endpoint: string): void {
    this.db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(endpoint)
  }

  pushSubscriptionsOf(userIds: string[]): Array<{ userId: string; subscription: PushSubscriptionJson }> {
    if (userIds.length === 0) return []
    const ph = userIds.map(() => '?').join(',')
    const rows = this.db.prepare(`SELECT endpoint, user_id, p256dh, auth FROM push_subscriptions WHERE user_id IN (${ph})`).all(...userIds) as Array<{
      endpoint: string
      user_id: string
      p256dh: string
      auth: string
    }>
    return rows.map((r) => ({ userId: r.user_id, subscription: { endpoint: r.endpoint, keys: { p256dh: r.p256dh, auth: r.auth } } }))
  }

  /* ---------- файлы ---------- */

  insertFile(f: NewFile): StoredFile {
    const now = Date.now()
    this.db
      .prepare(
        `INSERT INTO files (id, name, mime, size, kind, width, height, duration, thumb_id, is_thumb, uploader_id, message_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, NULL, ?)`
      )
      .run(f.id, f.name, f.mime, f.size, f.kind, f.width, f.height, f.duration, f.isThumb ? 1 : 0, f.uploaderId, now)
    return this.getFile(f.id)!
  }

  getFile(id: string): StoredFile | null {
    const r = this.db.prepare('SELECT * FROM files WHERE id = ?').get(id) as FileRow | undefined
    return r ? rowToFile(r) : null
  }

  setThumb(fileId: string, thumbId: string): void {
    this.db.prepare('UPDATE files SET thumb_id = ? WHERE id = ?').run(thumbId, fileId)
  }

  /** Удаляет записи и возвращает их (вместе с миниатюрами). */
  deleteFiles(ids: string[]): StoredFile[] {
    if (ids.length === 0) return []
    const run = this.db.transaction(() => {
      const placeholders = ids.map(() => '?').join(',')
      const rows = (this.db.prepare(`SELECT * FROM files WHERE id IN (${placeholders})`).all(...ids) as FileRow[]).map(rowToFile)
      const thumbIds = rows.map((r) => r.thumbId).filter((x): x is string => Boolean(x))
      const all = [...new Set([...ids, ...thumbIds])]
      const ph2 = all.map(() => '?').join(',')
      const withThumbs = (this.db.prepare(`SELECT * FROM files WHERE id IN (${ph2})`).all(...all) as FileRow[]).map(rowToFile)
      this.db.prepare(`DELETE FROM files WHERE id IN (${ph2})`).run(...all)
      return withThumbs
    })
    return run()
  }

  /** Загруженные, но так и не отправленные файлы старше указанного времени. */
  orphanFiles(olderThan: number): string[] {
    const rows = this.db
      .prepare(`SELECT id FROM files WHERE message_id IS NULL AND is_thumb = 0 AND kind != 'avatar' AND created_at < ?`)
      .all(olderThan) as Array<{ id: string }>
    return rows.map((r) => r.id)
  }

  /** Миниатюры, чей основной файл исчез (например, загрузка была прервана). */
  danglingThumbs(olderThan: number): string[] {
    const rows = this.db
      .prepare(
        `SELECT t.id FROM files t WHERE t.is_thumb = 1 AND t.message_id IS NULL AND t.created_at < ?
         AND NOT EXISTS (SELECT 1 FROM files p WHERE p.thumb_id = t.id)`
      )
      .all(olderThan) as Array<{ id: string }>
    return rows.map((r) => r.id)
  }

  /** Меняет аватарку и возвращает id прежней (чтобы удалить файл). */
  setUserAvatar(userId: string, fileId: string | null): string | null {
    const prev = this.getUser(userId)?.avatar ?? null
    this.db.prepare('UPDATE users SET avatar = ? WHERE id = ?').run(fileId, userId)
    return prev
  }

  /** Сколько места занимают все файлы (для панели хоста). */
  totalFilesSize(): number {
    return (this.db.prepare('SELECT COALESCE(SUM(size), 0) AS n FROM files').get() as { n: number }).n
  }
}
