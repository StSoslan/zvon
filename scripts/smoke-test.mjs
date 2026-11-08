#!/usr/bin/env node
/**
 * Автотест сервера хоста: поднимает out/main/server.js без UI (через Electron в режиме Node)
 * и гоняет протокол несколькими клиентами. Запуск: npm run test:server
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { request } from 'node:https'
import { randomUUID } from 'node:crypto'

const require = createRequire(import.meta.url)
const WebSocket = require('ws')

let PORT = 17000 + Math.floor(Math.random() * 2000)
const PASSWORD = 'test-pass'
const ADMIN_TOKEN = 'admin-token-for-tests-0123456789'
let dataDir = mkdtempSync(join(tmpdir(), 'zvon-test-'))

/** Версию протокола берём из /health, чтобы тест не устаревал. */
let PROTOCOL = 0
let failures = 0
let passed = 0
const ok = (cond, name) => {
  if (cond) {
    passed++
    console.log(`  ✔ ${name}`)
  } else {
    failures++
    console.log(`  ✘ ${name}`)
  }
}

function startServer(args = ['--password', PASSWORD, '--admin-token', ADMIN_TOKEN]) {
  const useNode = process.env.ZVON_TEST_NODE === '1'
  const bin = useNode ? process.execPath : require('electron')
  const child = spawn(
    bin,
    ['out/main/server.js', '--data', dataDir, '--port', String(PORT), '--name', 'Тестовый сервер', '--max-upload-mb', '1', ...args],
    { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ZVON_VERSION: 'test' }, stdio: ['ignore', 'pipe', 'pipe'] }
  )
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Сервер не стартовал за 20 с')), 20000)
    let out = ''
    child.stdout.on('data', (d) => {
      out += d.toString()
      if (process.env.VERBOSE) process.stdout.write(d)
      const m = /ZVON_READY (\{.*\})/.exec(out)
      if (m) {
        clearTimeout(timer)
        resolve({ child, info: JSON.parse(m[1]) })
      }
    })
    child.stderr.on('data', (d) => process.stderr.write(d))
    child.on('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`Сервер завершился с кодом ${code}\n${out}`))
    })
  })
}

function health() {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: PORT, path: '/health', rejectUnauthorized: false, agent: false }, (res) => {
      // Сокет нужно взять сразу: после окончания ответа он отсоединяется.
      const fingerprint = res.socket.getPeerX509Certificate().fingerprint256
      let body = ''
      res.on('data', (c) => (body += c))
      res.on('end', () => resolve({ body: JSON.parse(body), fingerprint }))
    })
    req.on('error', reject)
    req.end()
  })
}

/** headersOnly: тело не отправляется, ждём ответа на одни заголовки (сервер отклоняет по Content-Length). */
function http(method, path, { token, body, headers = {}, headersOnly = false } = {}) {
  return new Promise((resolve, reject) => {
    const h = { ...headers }
    if (token) h.Authorization = `Bearer ${token}`
    if (body) h['Content-Length'] = body.length
    const req = request({ host: '127.0.0.1', port: PORT, path, method, headers: h, rejectUnauthorized: false, agent: false }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => {
        const buf = Buffer.concat(chunks)
        let json = null
        try {
          json = JSON.parse(buf.toString())
        } catch {
          /* не JSON */
        }
        resolve({ status: res.statusCode, headers: res.headers, body: buf, json })
      })
    })
    req.on('error', reject)
    if (headersOnly) {
      // Если писать тело, сервер может закрыть сокет раньше, чем клиент прочитает 413 (ECONNRESET).
      req.on('response', (res) => res.on('end', () => req.destroy()))
      req.flushHeaders()
      return
    }
    if (body) req.write(body)
    req.end()
  })
}

class TestClient {
  constructor(name) {
    this.name = name
    this.clientId = randomUUID()
    this.events = []
    this.waiters = []
    this.nextId = 1
    this.pending = new Map()
  }

  open() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(`wss://127.0.0.1:${PORT}/ws`, { rejectUnauthorized: false })
      this.ws.on('open', resolve)
      this.ws.on('error', reject)
      this.ws.on('close', (code) => {
        this.closeCode = code
      })
      this.ws.on('message', (raw) => {
        const env = JSON.parse(raw.toString())
        if (env.t === 'res') {
          const p = this.pending.get(env.id)
          if (p) {
            this.pending.delete(env.id)
            p(env)
          }
          return
        }
        this.events.push(env)
        this.waiters = this.waiters.filter((w) => {
          if (w.match(env)) {
            w.resolve(env)
            return false
          }
          return true
        })
      })
    })
  }

  req(t, d) {
    const id = this.nextId++
    return new Promise((resolve) => {
      this.pending.set(id, resolve)
      this.ws.send(JSON.stringify({ t, id, d }))
    })
  }

  async hello(password = PASSWORD, nickname = this.name, adminToken = undefined) {
    return this.req('hello', { protocol: PROTOCOL, clientId: this.clientId, nickname, password, adminToken })
  }

  /** Вход по аккаунту (сервер с аккаунтами). */
  async login(login, password) {
    return this.req('hello', { protocol: PROTOCOL, clientId: this.clientId, nickname: login, password, login })
  }

  waitFor(t, pred = () => true, ms = 3000) {
    const found = this.events.find((e) => e.t === t && pred(e.d))
    if (found) return Promise.resolve(found)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${this.name}: не дождался ${t}`)), ms)
      this.waiters.push({
        match: (e) => e.t === t && pred(e.d),
        resolve: (e) => {
          clearTimeout(timer)
          resolve(e)
        }
      })
    })
  }

  noEvent(t, pred = () => true, ms = 800) {
    return new Promise((resolve) => setTimeout(() => resolve(!this.events.some((e) => e.t === t && pred(e.d))), ms))
  }

  clear() {
    this.events = []
  }
}

/** Сервер с аккаунтами: отдельный запуск со своими данными. */
async function accountsPhase() {
  PORT += 1
  dataDir = mkdtempSync(join(tmpdir(), 'zvon-test-acc-'))
  const { child } = await startServer(['--admin-login', 'admin', '--admin-password', 'admin-pass'])
  const clients = []
  const client = async (name) => {
    const c = new TestClient(name)
    await c.open()
    clients.push(c)
    return c
  }
  try {
    console.log('\nАккаунты')
    const h = await health()
    ok(h.body.accounts === true && h.body.requiresPassword === true, 'health сообщает, что вход по аккаунтам')
    const noLogin = await (await client('Гость')).hello('admin-pass')
    ok(!noLogin.ok, 'без логина войти нельзя')
    const wrong = await (await client('Админ')).login('admin', 'wrong-pass')
    ok(!wrong.ok && wrong.err.code === 'wrong_password', 'неверный пароль администратора отклонён')
    const admin = await client('Админ')
    const ra = await admin.login('ADMIN', 'admin-pass')
    ok(ra.ok && ra.d.you.isAdmin && ra.d.account?.login === 'admin', 'администратор вошёл (логин без учёта регистра)')

    const created = await admin.req('account-create', { login: 'vasya', password: 'vasya-123', isAdmin: false })
    ok(created.ok && created.d.account.login === 'vasya' && created.d.account.nickname === 'vasya', 'администратор создал аккаунт')
    const dup = await admin.req('account-create', { login: 'Vasya', password: 'whatever1', isAdmin: false })
    ok(!dup.ok, 'повторный логин не создаётся')
    const short = await admin.req('account-create', { login: 'kolya', password: '123', isAdmin: false })
    ok(!short.ok, 'слишком короткий пароль отклонён')
    const petya = await admin.req('account-create', { login: 'petya', password: 'petya-123', isAdmin: false })

    const vasya = await client('Вася')
    const rv = await vasya.login('vasya', 'vasya-123')
    ok(rv.ok && rv.d.you.nickname === 'vasya' && !rv.d.you.isAdmin, 'пользователь вошёл, ник — логин')
    const forbidden = await vasya.req('account-list', {})
    ok(!forbidden.ok, 'обычный пользователь не видит аккаунты')
    const nick = await vasya.req('profile-update', { nickname: 'Василий' })
    ok(nick.ok && nick.d.user.nickname === 'Василий', 'пользователь сменил ник')

    const p = await client('Петя')
    const rp = await p.login('petya', 'petya-123')
    const taken = await p.req('profile-update', { nickname: 'василий' })
    ok(rp.ok && !taken.ok, 'чужой ник занять нельзя')

    const badChange = await vasya.req('password-change', { oldPassword: 'nope', newPassword: 'vasya-456' })
    ok(!badChange.ok, 'смена пароля с неверным текущим отклонена')
    const change = await vasya.req('password-change', { oldPassword: 'vasya-123', newPassword: 'vasya-456' })
    ok(change.ok, 'пользователь сменил пароль')

    const phone = await client('Вася с телефона')
    const rphone = await phone.login('vasya', 'vasya-456')
    ok(rphone.ok && rphone.d.you.id === rv.d.you.id && rphone.d.you.nickname === 'Василий', 'вход с другого устройства — тот же пользователь и ник')
    await new Promise((r) => setTimeout(r, 200))
    ok(vasya.closeCode === undefined, 'прежнее подключение осталось: один аккаунт на двух устройствах')
    const pingBoth = await vasya.req('ping', {})
    ok(pingBoth.ok, 'первое устройство по-прежнему отвечает')
    const dmFromPhone = await phone.req('dm-open', { userId: rp.d.you.id })
    ok(dmFromPhone.ok && dmFromPhone.d.channel.type === 'dm' && dmFromPhone.d.channel.members.length === 2, 'личный канал открыт с телефона')
    const dmAgain = await vasya.req('dm-open', { userId: rp.d.you.id })
    ok(dmAgain.ok && dmAgain.d.channel.id === dmFromPhone.d.channel.id, 'с другого устройства — тот же личный канал')
    const dmMsg = await phone.req('msg-send', { channelId: dmFromPhone.d.channel.id, content: 'привет лично' })
    ok(dmMsg.ok, 'сообщение в личный канал отправлено')
    await vasya.waitFor('msg-new', (d) => d.message.channelId === dmFromPhone.d.channel.id)
    ok(true, 'второе устройство автора получило сообщение личного канала')
    ok(await admin.noEvent('msg-new', (d) => d.message.channelId === dmFromPhone.d.channel.id, 300), 'посторонний личное сообщение не получил')
    const foreignHistory = await admin.req('msg-history', { channelId: dmFromPhone.d.channel.id })
    ok(!foreignHistory.ok, 'чужую переписку прочитать нельзя')
    const reply = await p.req('msg-send', { channelId: dmFromPhone.d.channel.id, content: 'и тебе', replyTo: dmMsg.d.message.id })
    ok(reply.ok && reply.d.message.replyTo?.id === dmMsg.d.message.id && reply.d.message.replyTo.content === 'привет лично', 'ответ с цитатой исходного сообщения')
    const found = await p.req('msg-search', { query: 'ЛИЧНО' })
    ok(found.ok && found.d.messages.some((m) => m.id === dmMsg.d.message.id), 'поиск находит слово без учёта регистра')
    const foundNothing = await admin.req('msg-search', { query: 'лично' })
    ok(foundNothing.ok && foundNothing.d.messages.length === 0, 'поиск не показывает чужие личные сообщения')
    const status = await vasya.req('status-set', { text: 'отошёл, буду в 17:30' })
    ok(status.ok && status.d.user.status === 'отошёл, буду в 17:30', 'статус участника сохранён')
    await p.waitFor('user-updated', (d) => d.user.id === rv.d.you.id && d.user.status === 'отошёл, буду в 17:30')
    ok(true, 'другие участники увидели статус')
    const role = await admin.req('role-create', { name: 'Ветеран', color: '#F0B232' })
    ok(role.ok && role.d.role.color === '#f0b232', 'администратор создал роль')
    const assigned = await admin.req('role-assign', { userId: rv.d.you.id, roleId: role.d.role.id, assigned: true })
    ok(assigned.ok && assigned.d.user.roles.includes(role.d.role.id), 'роль выдана участнику')
    const roleByUser = await vasya.req('role-create', { name: 'Хакер', color: '#000000' })
    ok(!roleByUser.ok, 'обычный участник роли не создаёт')
    const presets = await admin.req('status-presets-set', { presets: ['Отошёл', 'На созвоне'] })
    ok(presets.ok && presets.d.presets.length === 2, 'администратор задал готовые статусы')
    const unreadOf = async () => {
      const c = await client('Петя заново')
      const r = await c.login('petya', 'petya-123')
      c.ws.close()
      return r.d.unread
    }
    ok(!(await unreadOf())[dmFromPhone.d.channel.id], 'после своего ответа переписка считается прочитанной')
    const later = await phone.req('msg-send', { channelId: dmFromPhone.d.channel.id, content: 'ещё одно' })
    ok(later.ok, 'новое личное сообщение отправлено')
    const unreadNow = (await unreadOf())[dmFromPhone.d.channel.id]
    ok(unreadNow?.count === 1 && unreadNow?.mentions === 1 && unreadNow?.firstUnreadId === later.d.message.id, 'непрочитанное в личном канале считается при входе')
    const readIt = await p.req('msg-read', { channelId: dmFromPhone.d.channel.id, messageId: dmMsg.d.message.id })
    ok(readIt.ok, 'отметка о прочтении принята')

    const list = await admin.req('account-list', {})
    ok(list.ok && list.d.accounts.length === 3 && list.d.accounts.find((a) => a.login === 'vasya')?.online === true, 'список аккаунтов с отметкой «в сети»')
    const selfDisable = await admin.req('account-update', { accountId: ra.d.you.id, disabled: true })
    ok(!selfDisable.ok, 'администратор не может отключить себя')

    const disable = await admin.req('account-update', { accountId: rv.d.you.id, disabled: true })
    await new Promise((r) => setTimeout(r, 200))
    ok(disable.ok && phone.closeCode === 4003, 'отключённый аккаунт сразу выходит с сервера')
    const afterDisable = await (await client('Вася')).login('vasya', 'vasya-456')
    ok(!afterDisable.ok && /отключ/.test(afterDisable.err.message), 'отключённый аккаунт не может войти')

    const reset = await admin.req('account-update', { accountId: petya.d.account.id, password: 'petya-new-1' })
    const petyaNew = await (await client('Петя')).login('petya', 'petya-new-1')
    ok(reset.ok && petyaNew.ok, 'администратор задал новый пароль, вход с ним работает')
    const del = await admin.req('account-delete', { accountId: petya.d.account.id })
    const petyaGone = await (await client('Петя')).login('petya', 'petya-new-1')
    ok(del.ok && !petyaGone.ok, 'удалённый аккаунт не может войти')
  } finally {
    for (const c of clients) c.ws?.close()
    child.kill('SIGTERM')
    await new Promise((r) => setTimeout(r, 500))
    try {
      rmSync(dataDir, { recursive: true, force: true })
    } catch {
      /* Windows может держать файл БД ещё мгновение */
    }
  }
}

async function main() {
  console.log(`Сервер: порт ${PORT}, данные ${dataDir}`)
  const { child, info } = await startServer()

  try {
    console.log('\n/health и сертификат')
    const h = await health()
    PROTOCOL = h.body.protocol
    ok(h.body.app === 'zvon' && h.body.requiresPassword === true, 'health отвечает и требует пароль')
    ok(h.fingerprint === info.fingerprint, 'отпечаток сертификата совпадает с объявленным')

    console.log('\nВеб-версия')
    const page = await http('GET', '/')
    ok(page.status === 200 && /text\/html/.test(page.headers['content-type']) && page.body.includes('id="root"'), 'главная страница отдаётся')
    const script = /src="(\/assets\/[^"]+\.js)"/.exec(page.body.toString())?.[1]
    const asset = script ? await http('GET', script) : null
    ok(asset?.status === 200 && /immutable/.test(asset.headers['cache-control']), 'скрипт веб-версии отдаётся с долгим кешем')
    const deep = await http('GET', '/channel/something')
    ok(deep.status === 200 && deep.body.includes('id="root"'), 'вложенный адрес открывает приложение')
    const escape = await http('GET', '/assets/..%2f..%2f..%2fpackage.json')
    ok(escape.status === 404, 'файлы вне веб-версии недоступны')

    console.log('\nВход')
    const intruder = new TestClient('Взломщик')
    await intruder.open()
    const bad = await intruder.hello('wrong')
    ok(!bad.ok && bad.err.code === 'wrong_password', 'неверный пароль отклонён')
    const notAuthed = new TestClient('Аноним')
    await notAuthed.open()
    const na = await notAuthed.req('msg-history', { channelId: 'x' })
    ok(!na.ok && na.err.code === 'not_authenticated', 'запросы без hello запрещены')
    notAuthed.ws.close()

    const alice = new TestClient('Алиса')
    const bob = new TestClient('Боб')
    const carol = new TestClient('Кэрол')
    await Promise.all([alice.open(), bob.open(), carol.open()])
    const ra = await alice.hello()
    ok(ra.ok && ra.d.channels.length >= 2, 'Алиса вошла, есть каналы')
    const rb = await bob.hello()
    ok(rb.ok, 'Боб вошёл')
    await alice.waitFor('user-joined', (d) => d.user.nickname === 'Боб')
    ok(true, 'Алиса получила user-joined для Боба')
    const rc = await carol.hello(PASSWORD, 'Боб')
    ok(rc.ok && rc.d.you.nickname === 'Боб (2)', 'занятый ник получает суффикс «(2)»')

    const channel = ra.d.channels.find((c) => c.type === 'text')
    const voice = ra.d.channels.find((c) => c.type === 'voice')
    const bobId = rb.d.you.id

    console.log('\nСообщения')
    const sent = await alice.req('msg-send', { channelId: channel.id, content: 'Привет, @Боб! 👋', nonce: 'n1' })
    ok(sent.ok && sent.d.message.nonce === 'n1', 'сообщение отправлено, nonce вернулся')
    ok(sent.ok && sent.d.message.mentions.includes(bobId), 'упоминание @Боб распознано')
    const got = await bob.waitFor('msg-new', (d) => d.message.id === sent.d.message.id)
    ok(got.d.message.content === 'Привет, @Боб! 👋', 'Боб получил сообщение')
    await carol.waitFor('msg-new', (d) => d.message.id === sent.d.message.id)
    ok(true, 'Кэрол получила сообщение')
    ok(await alice.noEvent('msg-new', (d) => d.message.id === sent.d.message.id, 300), 'автор не получает своё сообщение повторно')

    const everyone = await alice.req('msg-send', { channelId: channel.id, content: '@everyone сбор в 9' })
    ok(everyone.d.message.mentions.includes('everyone'), '@everyone распознано')

    const toVoice = await alice.req('msg-send', { channelId: voice.id, content: 'тест' })
    ok(!toVoice.ok && toVoice.err.code === 'bad_request', 'в голосовой канал писать нельзя')
    const empty = await alice.req('msg-send', { channelId: channel.id, content: '   ' })
    ok(!empty.ok, 'пустое сообщение отклонено')
    const huge = await alice.req('msg-send', { channelId: channel.id, content: 'x'.repeat(5000) })
    ok(!huge.ok, 'слишком длинное сообщение отклонено')

    console.log('\nРедактирование и удаление')
    const foreignEdit = await bob.req('msg-edit', { messageId: sent.d.message.id, content: 'взлом' })
    ok(!foreignEdit.ok && foreignEdit.err.code === 'forbidden', 'чужое сообщение редактировать нельзя')
    const foreignDel = await bob.req('msg-delete', { messageId: sent.d.message.id })
    ok(!foreignDel.ok && foreignDel.err.code === 'forbidden', 'чужое сообщение удалять нельзя')
    const edit = await alice.req('msg-edit', { messageId: sent.d.message.id, content: 'Привет всем' })
    ok(edit.ok && edit.d.message.editedAt !== null && edit.d.message.mentions.length === 0, 'своё сообщение отредактировано')
    await bob.waitFor('msg-updated', (d) => d.message.content === 'Привет всем')
    ok(true, 'Боб получил msg-updated')
    const del = await alice.req('msg-delete', { messageId: sent.d.message.id })
    ok(del.ok, 'своё сообщение удалено')
    await bob.waitFor('msg-deleted', (d) => d.messageId === sent.d.message.id)
    ok(true, 'Боб получил msg-deleted')

    console.log('\n«Печатает…»')
    await bob.req('typing', { channelId: channel.id })
    await alice.waitFor('typing', (d) => d.userId === bobId)
    ok(true, 'Алиса видит, что Боб печатает')

    console.log('\nИстория и пагинация')
    for (let i = 1; i <= 60; i++) {
      const r = await carol.req('msg-send', { channelId: channel.id, content: `сообщение ${i}` })
      if (!r.ok) {
        // ограничитель частоты: подождать и повторить
        await new Promise((res) => setTimeout(res, 400))
        i--
      }
    }
    const page1 = await bob.req('msg-history', { channelId: channel.id, limit: 50 })
    ok(page1.ok && page1.d.messages.length === 50 && page1.d.hasMore, 'первая страница: 50 сообщений, есть ещё')
    ok(page1.d.messages[49].content === 'сообщение 60', 'последнее сообщение — самое новое')
    const page2 = await bob.req('msg-history', { channelId: channel.id, before: page1.d.messages[0].id, limit: 50 })
    ok(page2.ok && page2.d.messages.length === 11 && !page2.d.hasMore, 'вторая страница: остаток, больше нет')

    console.log('\nОбрыв и переподключение')
    alice.clear()
    bob.ws.terminate()
    ok(await alice.noEvent('user-left', (d) => d.userId === bobId, 1500), 'при обрыве user-left не приходит сразу (ждём переподключения)')
    const bob2 = new TestClient('Боб')
    bob2.clientId = bob.clientId
    await bob2.open()
    const rb2 = await bob2.hello()
    ok(rb2.ok && rb2.d.you.id === bobId, 'Боб переподключился с тем же id')
    await alice.waitFor('user-updated', (d) => d.user.id === bobId)
    ok(await alice.noEvent('user-joined', (d) => d.user.id === bobId, 300), 'переподключение не выглядит как новый вход')

    console.log('\nВторое подключение того же устройства')
    const bob3 = new TestClient('Боб')
    bob3.clientId = bob.clientId
    await bob3.open()
    await bob3.hello()
    await new Promise((r) => setTimeout(r, 300))
    ok(bob2.closeCode === undefined, 'старое подключение не вытесняется: оба окна работают')

    console.log('\nФайлы')
    const aTok = ra.d.fileToken
    const bTok = rb.d.fileToken
    ok(typeof aTok === 'string' && aTok.length > 20 && ra.d.maxUploadBytes === 1024 * 1024, 'hello выдаёт токен файлов и лимит (1 МБ)')
    const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(3000, 7)])
    const noAuth = await http('PUT', '/upload?name=x.png&type=image/png', { body: png })
    ok(noAuth.status === 401, 'загрузка без токена запрещена')
    const up = await http('PUT', `/upload?name=${encodeURIComponent('кот.png')}&type=image/png&width=800&height=600`, { token: aTok, body: png })
    ok(up.status === 200 && up.json.file.kind === 'image' && up.json.file.width === 800, 'картинка загружена')
    const imgId = up.json.file.id
    const thumb = await http('PUT', `/upload?name=thumb.webp&type=image/webp&thumbOf=${imgId}`, { token: aTok, body: Buffer.alloc(500, 1) })
    ok(thumb.status === 200, 'миниатюра загружена')
    const tooBig = await http('PUT', '/upload?name=big.bin&type=application/octet-stream', { token: aTok, body: Buffer.alloc(1024 * 1024 + 10), headersOnly: true })
    ok(tooBig.status === 413, 'файл больше лимита отклонён (413)')
    const svg = await http('PUT', '/upload?name=x.svg&type=image/svg+xml', { token: aTok, body: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>') })
    ok(svg.status === 200 && svg.json.file.kind === 'file', 'SVG сохраняется как обычный файл (без показа)')
    const traversal = await http('PUT', `/upload?name=${encodeURIComponent('../../evil.txt')}&type=text/plain`, { token: aTok, body: Buffer.from('x') })
    ok(traversal.status === 200 && traversal.json.file.name === 'evil.txt', 'путь в имени файла отбрасывается')

    const withFile = await alice.req('msg-send', { channelId: channel.id, content: '', attachments: [imgId] })
    ok(withFile.ok && withFile.d.message.attachments[0]?.thumbId === thumb.json.file.id, 'сообщение с вложением (без текста) отправлено, миниатюра привязана')
    const bobGot = await bob3.waitFor('msg-new', (d) => d.message.id === withFile.d.message.id)
    ok(bobGot.d.message.attachments[0].name === 'кот.png', 'Боб получил сообщение с файлом')
    const again = await alice.req('msg-send', { channelId: channel.id, content: 'ещё раз', attachments: [imgId] })
    ok(!again.ok, 'один файл нельзя отправить дважды')
    const foreign = await bob3.req('msg-send', { channelId: channel.id, content: 'чужое', attachments: [svg.json.file.id] })
    ok(!foreign.ok, 'чужой файл прикрепить нельзя')

    const get = await http('GET', `/files/${imgId}?t=${bTok}`)
    ok(get.status === 200 && get.body.equals(png) && get.headers['content-type'] === 'image/png', 'Боб скачивает картинку по своему токену')
    const ranged = await http('GET', `/files/${imgId}`, { token: bTok, headers: { Range: 'bytes=0-3' } })
    ok(ranged.status === 206 && ranged.body.length === 4 && ranged.headers['content-range'] === `bytes 0-3/${png.length}`, 'Range-запрос (перемотка видео) работает')
    const svgGet = await http('GET', `/files/${svg.json.file.id}`, { token: aTok })
    ok(svgGet.headers['content-type'] === 'application/octet-stream' && /^attachment/.test(svgGet.headers['content-disposition']), 'SVG отдаётся только как скачивание')
    const badTok = await http('GET', `/files/${imgId}?t=nope`)
    ok(badTok.status === 401, 'неверный токен не пускает к файлам')

    const delAttached = await http('DELETE', `/files/${imgId}`, { token: aTok })
    ok(delAttached.status === 409, 'отправленный файл нельзя удалить напрямую')
    const delForeign = await http('DELETE', `/files/${svg.json.file.id}`, { token: bTok })
    ok(delForeign.status === 403, 'чужой файл удалить нельзя')
    const delOwn = await http('DELETE', `/files/${svg.json.file.id}`, { token: aTok })
    ok(delOwn.status === 204, 'свой неотправленный файл удалён')

    const hist = await bob3.req('msg-history', { channelId: channel.id, limit: 5 })
    ok(hist.d.messages.some((m) => m.attachments.some((a) => a.id === imgId)), 'вложения приходят в истории')
    await alice.req('msg-delete', { messageId: withFile.d.message.id })
    await new Promise((r) => setTimeout(r, 100))
    const gone = await http('GET', `/files/${imgId}`, { token: bTok })
    const thumbGone = await http('GET', `/files/${thumb.json.file.id}`, { token: bTok })
    ok(gone.status === 404 && thumbGone.status === 404, 'удаление сообщения удаляет файл и миниатюру')

    const av = await http('PUT', '/upload?name=me.webp&type=image/webp&purpose=avatar', { token: aTok, body: Buffer.alloc(800, 3) })
    ok(av.status === 200 && av.json.file.kind === 'avatar', 'аватарка загружена')
    const prof = await alice.req('profile-update', { nickname: 'Алиса', avatar: av.json.file.id })
    ok(prof.ok && prof.d.user.avatar === av.json.file.id, 'аватарка установлена в профиль')
    await bob3.waitFor('user-updated', (d) => d.user.id === ra.d.you.id && d.user.avatar === av.json.file.id)
    ok(true, 'Боб видит новую аватарку Алисы')
    const avGet = await http('GET', `/files/${av.json.file.id}`, { token: bTok })
    ok(avGet.status === 200, 'аватарка доступна по ссылке')
    const avNotImage = await http('PUT', '/upload?name=me.txt&type=text/plain&purpose=avatar', { token: aTok, body: Buffer.from('x') })
    ok(avNotImage.status === 415, 'аватарка не из картинки отклонена')
    const avRemove = await alice.req('profile-update', { nickname: 'Алиса', avatar: null })
    const oldAv = await http('GET', `/files/${av.json.file.id}`, { token: bTok })
    ok(avRemove.ok && avRemove.d.user.avatar === null && oldAv.status === 404, 'аватарку можно убрать, старый файл удаляется')

    console.log('\nГолос (сигналинг SFU)')
    if (rb.d.voiceError) {
      console.log(`  ⚠ голос недоступен на этом сервере: ${rb.d.voiceError} — проверки голоса пропущены`)
    } else {
      bob3.clear()
      const vj = await alice.req('voice-join', { channelId: voice.id })
      ok(vj.ok && Array.isArray(vj.d.routerRtpCapabilities.codecs), 'Алиса вошла в голосовой канал, получила возможности роутера')
      await bob3.waitFor('voice-state', (d) => d.userId === ra.d.you.id && d.state?.channelId === voice.id)
      ok(true, 'Боб видит Алису в голосовом канале')
      const caps = vj.d.routerRtpCapabilities
      const ready = await alice.req('voice-ready', { rtpCapabilities: caps })
      ok(ready.ok && ready.d.producers.length === 0, 'voice-ready: чужих потоков пока нет')
      const send = await alice.req('transport-create', { direction: 'send' })
      ok(send.ok && send.d.iceCandidates.some((c) => c.port === info.rtcPort), `транспорт отправки слушает порт ${info.rtcPort}`)
      const opus = caps.codecs.find((c) => c.mimeType.toLowerCase() === 'audio/opus')
      const prod = await alice.req('produce', {
        transportId: send.d.id,
        kind: 'audio',
        source: 'mic',
        rtpParameters: {
          mid: '0',
          codecs: [{ mimeType: 'audio/opus', payloadType: opus.preferredPayloadType, clockRate: 48000, channels: 2, parameters: { useinbandfec: 1, usedtx: 1 }, rtcpFeedback: [] }],
          headerExtensions: [],
          encodings: [{ ssrc: 22222222 }],
          rtcp: { cname: 'alice', reducedSize: true }
        }
      })
      ok(prod.ok, 'Алиса опубликовала микрофон' + (prod.ok ? '' : `: ${prod.err.message}`))
      const badProduce = await alice.req('produce', { transportId: send.d.id, kind: 'video', source: 'mic', rtpParameters: {} })
      ok(!badProduce.ok, 'видео с источником «микрофон» отклонено')

      const bj = await bob3.req('voice-join', { channelId: voice.id })
      ok(bj.ok, 'Боб вошёл в тот же канал')
      const bready = await bob3.req('voice-ready', { rtpCapabilities: bj.d.routerRtpCapabilities })
      const alicesMic = bready.d.producers.find((p) => p.userId === ra.d.you.id && p.source === 'mic')
      ok(Boolean(alicesMic), 'Боб получил список потоков с микрофоном Алисы')
      const recv = await bob3.req('transport-create', { direction: 'recv' })
      ok(recv.ok, 'у Боба создан транспорт приёма')
      const cons = await bob3.req('consume', { producerId: alicesMic.producerId })
      ok(cons.ok && cons.d.kind === 'audio' && cons.d.userId === ra.d.you.id, 'Боб принимает голос Алисы' + (cons.ok ? '' : `: ${cons.err.message}`))
      const res = await bob3.req('consumer-resume', { consumerId: cons.d.consumerId })
      ok(res.ok, 'приём снят с паузы')
      const self = await alice.req('consume', { producerId: prod.d.producerId })
      ok(!self.ok, 'свой поток принимать нельзя')

      // Камера с simulcast (3 слоя VP8) и выбор качества зрителем
      const vp8 = caps.codecs.find((c) => c.mimeType.toLowerCase() === 'video/vp8')
      const cam = await alice.req('produce', {
        transportId: send.d.id,
        kind: 'video',
        source: 'camera',
        rtpParameters: {
          mid: '1',
          codecs: [{ mimeType: 'video/VP8', payloadType: vp8.preferredPayloadType, clockRate: 90000, parameters: {}, rtcpFeedback: [] }],
          headerExtensions: [],
          encodings: [
            { ssrc: 33330001, scalabilityMode: 'L1T3', scaleResolutionDownBy: 4 },
            { ssrc: 33330002, scalabilityMode: 'L1T3', scaleResolutionDownBy: 2 },
            { ssrc: 33330003, scalabilityMode: 'L1T3', scaleResolutionDownBy: 1 }
          ],
          rtcp: { cname: 'alice', reducedSize: true }
        }
      })
      ok(cam.ok, 'Алиса включила камеру (simulcast 3 слоя)' + (cam.ok ? '' : `: ${cam.err.message}`))
      await bob3.waitFor('new-producer', (d) => d.producerId === cam.d?.producerId && d.source === 'camera')
      ok(true, 'Боб получил уведомление о камере')
      const vcons = await bob3.req('consume', { producerId: cam.d.producerId })
      ok(vcons.ok && vcons.d.kind === 'video' && vcons.d.spatialLayers === 3, 'видео принимается, у потока 3 слоя' + (vcons.ok ? ` (${vcons.d.spatialLayers})` : `: ${vcons.err.message}`))
      const layersSet = await bob3.req('consumer-set-layers', { consumerId: vcons.d.consumerId, spatialLayer: 0 })
      ok(layersSet.ok, 'зритель выбрал низкое качество')
      const camClose = await alice.req('producer-close', { producerId: cam.d.producerId })
      ok(camClose.ok, 'Алиса выключила камеру')
      await bob3.waitFor('consumer-closed', (d) => d.consumerId === vcons.d.consumerId)
      ok(true, 'у Боба закрылся приём камеры')

      // Демонстрация экрана: кто ведёт и кто смотрит
      const scr = await alice.req('produce', {
        transportId: send.d.id,
        kind: 'video',
        source: 'screen',
        rtpParameters: {
          mid: '2',
          codecs: [{ mimeType: 'video/VP8', payloadType: vp8.preferredPayloadType, clockRate: 90000, parameters: {}, rtcpFeedback: [] }],
          headerExtensions: [],
          encodings: [{ ssrc: 44440001 }],
          rtcp: { cname: 'alice', reducedSize: true }
        }
      })
      ok(scr.ok, 'Алиса начала демонстрацию экрана' + (scr.ok ? '' : `: ${scr.err.message}`))
      await bob3.waitFor('voice-state', (d) => d.userId === ra.d.you.id && d.state?.streaming === true)
      ok(true, 'Боб видит, что Алиса в эфире')
      const scons = await bob3.req('consume', { producerId: scr.d.producerId })
      await bob3.req('consumer-resume', { consumerId: scons.d.consumerId })
      await alice.waitFor('voice-state', (d) => d.userId === rb.d.you.id && d.state?.watching?.includes(ra.d.you.id))
      ok(true, 'Алиса видит, что Боб смотрит её экран')
      await bob3.req('consumer-pause', { consumerId: scons.d.consumerId })
      await alice.waitFor('voice-state', (d) => d.userId === rb.d.you.id && d.state?.watching?.length === 0)
      ok(true, 'Боб свернул демонстрацию — больше не в списке зрителей')
      await alice.req('producer-close', { producerId: scr.d.producerId })
      await bob3.waitFor('voice-state', (d) => d.userId === ra.d.you.id && d.state?.streaming === false)
      ok(true, 'демонстрация закончилась — Алиса больше не в эфире')

      const pause = await alice.req('producer-pause', { producerId: prod.d.producerId })
      const resume = await alice.req('producer-resume', { producerId: prod.d.producerId })
      ok(pause.ok && resume.ok, 'пауза и возобновление микрофона')
      await alice.req('voice-state-update', { muted: true, deafened: false })
      await bob3.waitFor('voice-state', (d) => d.userId === ra.d.you.id && d.state?.muted === true)
      ok(true, 'Боб видит, что Алиса выключила микрофон')

      // Кэрол в текстовом канале голос не нужен
      const wrong = await alice.req('voice-join', { channelId: channel.id })
      ok(!wrong.ok, 'войти голосом в текстовый канал нельзя')
      // после неудачной попытки Алиса всё ещё в голосе? Повторно входим, чтобы продолжить сценарий
      const rejoin = await alice.req('voice-join', { channelId: voice.id })
      ok(rejoin.ok, 'повторный вход в тот же канал работает')
      await bob3.waitFor('producer-closed', (d) => d.producerId === prod.d.producerId)
      ok(true, 'при повторном входе старый поток Алисы закрыт у Боба')

      await alice.req('voice-leave', {})
      await bob3.waitFor('voice-state', (d) => d.userId === ra.d.you.id && d.state === null)
      ok(true, 'выход Алисы из голоса виден Бобу')
      await bob3.req('voice-leave', {})
    }

    console.log('\nПанель хоста')
    const notAdmin = await alice.req('admin-stats', {})
    ok(!notAdmin.ok && notAdmin.err.code === 'forbidden', 'обычному участнику панель хоста недоступна')
    const host = new TestClient('Хост')
    await host.open()
    const rh = await host.hello(PASSWORD, 'Хост', ADMIN_TOKEN)
    ok(rh.ok && rh.d.you.isAdmin, 'вход с токеном хоста даёт права администратора')
    const stats = await host.req('admin-stats', {})
    ok(stats.ok && stats.d.users.length >= 3 && stats.d.settings.maxUploadMb === 1, 'статистика: участники и настройки')
    ok(stats.ok && typeof stats.d.sfu.cpuPercent === 'number' && stats.d.sfu.rtcPort === info.rtcPort, 'статистика SFU: CPU и порт медиа')

    alice.clear()
    const created = await host.req('channel-create', { name: 'новости', type: 'text' })
    ok(created.ok && created.d.channel.name === 'новости', 'хост создал текстовый канал')
    await alice.waitFor('channels-updated', (d) => d.channels.some((c) => c.name === 'новости'))
    ok(true, 'участники получили обновлённый список каналов')
    const renamed = await host.req('channel-rename', { channelId: created.d.channel.id, name: 'объявления' })
    ok(renamed.ok && renamed.d.channel.name === 'объявления', 'канал переименован')
    const moved = await host.req('channel-move', { channelId: created.d.channel.id, direction: 'up' })
    const listAfterMove = (await alice.waitFor('channels-updated', (d) => {
      const text = d.channels.filter((c) => c.type === 'text')
      return text.length > 1 && text[text.length - 2].id === created.d.channel.id
    })).d.channels
    ok(moved.ok && listAfterMove.length > 0, 'канал сдвинут вверх')
    await host.req('msg-send', { channelId: created.d.channel.id, content: 'важное' })
    const vch = await host.req('channel-create', { name: 'Стрим', type: 'voice' })
    const delCh = await host.req('channel-delete', { channelId: created.d.channel.id })
    ok(delCh.ok, 'канал с сообщениями удалён')
    const histGone = await alice.req('msg-history', { channelId: created.d.channel.id })
    ok(!histGone.ok, 'история удалённого канала недоступна')
    await host.req('channel-delete', { channelId: vch.d.channel.id })

    const set = await host.req('admin-settings', { maxUploadMb: 2, maxIncomingKbps: 5000, maxOutgoingKbps: 20000 })
    ok(set.ok && set.d.settings.maxUploadMb === 2 && set.d.settings.maxIncomingKbps === 5000, 'настройки сервера изменены')
    await alice.waitFor('server-settings', (d) => d.maxUploadBytes === 2 * 1024 * 1024)
    ok(true, 'участники узнали новый лимит файла')
    const badSet = await host.req('admin-settings', { maxIncomingKbps: 10 })
    ok(!badSet.ok, 'слишком маленький лимит битрейта отклонён')

    const dave = new TestClient('Дейв')
    await dave.open()
    const rd = await dave.hello()
    const selfKick = await host.req('admin-kick', { userId: rh.d.you.id, ban: false })
    ok(!selfKick.ok, 'хост не может отключить сам себя')
    await host.req('admin-kick', { userId: rd.d.you.id, ban: true })
    await new Promise((r) => setTimeout(r, 300))
    ok(dave.closeCode === 4003, 'участник отключён хостом (код 4003)')
    const dave2 = new TestClient('Дейв')
    dave2.clientId = dave.clientId
    await dave2.open()
    const rejected = await dave2.hello()
    ok(!rejected.ok && rejected.err.code === 'forbidden', 'заблокированный не может войти снова')
    const unban = await host.req('admin-unban', { userId: rd.d.you.id })
    const dave3 = new TestClient('Дейв')
    dave3.clientId = dave.clientId
    await dave3.open()
    const back = await dave3.hello()
    ok(unban.ok && back.ok, 'после разблокировки вход снова работает')
    dave3.ws.close(1000)
    host.ws.close(1000)

    console.log('\nВыход')
    carol.ws.close(1000)
    await alice.waitFor('user-left', (d) => d.userId === rc.d.you.id)
    ok(true, 'обычный выход сразу рассылает user-left')

    // В самом конце: блокировка закрывает вход с 127.0.0.1 для всех следующих проверок.
    console.log('\nЗащита от перебора пароля')
    const guessers = Array.from({ length: 9 }, (_, i) => new TestClient(`Перебор${i}`))
    await Promise.all(guessers.map((g) => g.open()))
    await Promise.all(guessers.map((g) => g.hello(`guess-${g.name}`)))
    const late = new TestClient('Опоздавший')
    await late.open()
    const locked = await late.hello(PASSWORD)
    ok(!locked.ok && /Слишком много/.test(locked.err.message), 'после 10 неверных паролей вход с адреса временно закрыт')

    for (const c of [alice, bob3, intruder]) c.ws?.close()
  } finally {
    child.kill('SIGTERM')
    await new Promise((r) => setTimeout(r, 500))
    try {
      rmSync(dataDir, { recursive: true, force: true })
    } catch {
      /* Windows может держать файл БД ещё мгновение */
    }
  }

  await accountsPhase()

  console.log(`\nИтог: ${passed} пройдено, ${failures} провалено`)
  process.exit(failures ? 1 : 0)
}

main().catch((err) => {
  console.error('Тест упал:', err)
  try {
    rmSync(dataDir, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
  process.exit(1)
})
