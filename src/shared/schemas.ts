/**
 * Валидация входящих запросов на сервере. Типы запросов описаны в types.ts,
 * схемы обязаны им соответствовать (проверяется через satisfies ниже).
 */
import { z } from 'zod'
import { LIMITS } from './constants'
import type { RequestMap, RequestType } from './types'

const id = z.string().min(1).max(64)
const nickname = z
  .string()
  .trim()
  .min(1, 'Ник не может быть пустым')
  .max(LIMITS.nicknameLength, `Ник длиннее ${LIMITS.nicknameLength} символов`)
  .refine((v) => !/[\u0000-\u001f@]/.test(v), 'Ник не должен содержать @ и служебные символы')
/** Структуры mediasoup проверяются самим mediasoup; здесь — только «это объект». */
const mediaJson = z.record(z.string(), z.unknown())
const content = z
  .string()
  .max(LIMITS.messageLength, `Сообщение длиннее ${LIMITS.messageLength} символов`)
  .refine((v) => v.trim().length > 0, 'Пустое сообщение')
const channelName = z
  .string()
  .trim()
  .min(1, 'Название канала не может быть пустым')
  .max(LIMITS.channelNameLength, `Название длиннее ${LIMITS.channelNameLength} символов`)
  // eslint-disable-next-line no-control-regex
  .refine((v) => !/[\u0000-\u001f]/.test(v), 'Недопустимые символы в названии')
const fileId = z.string().regex(/^[0-9a-f]{32}$/, 'Неверный id файла')
const login = z
  .string()
  .trim()
  .regex(/^[a-zA-Z0-9._-]{2,32}$/, 'Логин: от 2 до 32 латинских букв, цифр, точек, дефисов или подчёркиваний')
const statusText = z
  .string()
  .trim()
  .min(1, 'Пустой статус')
  .max(LIMITS.statusLength, `Статус длиннее ${LIMITS.statusLength} символов`)
  // eslint-disable-next-line no-control-regex
  .refine((v) => !/[\u0000-\u001f]/.test(v), 'Недопустимые символы в статусе')
const roleName = z
  .string()
  .trim()
  .min(1, 'Название роли не может быть пустым')
  .max(LIMITS.roleNameLength, `Название длиннее ${LIMITS.roleNameLength} символов`)
const roleColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Цвет в формате #rrggbb')
const newPassword = z
  .string()
  .min(LIMITS.accountPasswordMin, `Пароль не короче ${LIMITS.accountPasswordMin} символов`)
  .max(LIMITS.passwordLength, `Пароль длиннее ${LIMITS.passwordLength} символов`)

export const requestSchemas = {
  hello: z.object({
    protocol: z.number().int(),
    clientId: z.string().min(8).max(64),
    nickname,
    password: z.string().max(LIMITS.passwordLength),
    adminToken: z.string().max(128).optional(),
    login: z.string().trim().max(64).optional()
  }),
  'password-change': z.object({ oldPassword: z.string().max(LIMITS.passwordLength), newPassword }),
  'account-list': z.object({}),
  'account-create': z.object({ login, password: newPassword, isAdmin: z.boolean() }),
  'account-update': z.object({ accountId: id, password: newPassword.optional(), isAdmin: z.boolean().optional(), disabled: z.boolean().optional() }),
  'account-delete': z.object({ accountId: id }),
  ping: z.object({}),
  'msg-send': z
    .object({
      channelId: id,
      content: z.string().max(LIMITS.messageLength, `Сообщение длиннее ${LIMITS.messageLength} символов`),
      nonce: z.string().max(64).optional(),
      attachments: z.array(fileId).max(LIMITS.attachmentsPerMessage, `Не больше ${LIMITS.attachmentsPerMessage} файлов`).optional(),
      replyTo: z.number().int().positive().optional()
    })
    .refine((m) => m.content.trim().length > 0 || (m.attachments?.length ?? 0) > 0, 'Пустое сообщение'),
  'msg-edit': z.object({ messageId: z.number().int().positive(), content }),
  'msg-delete': z.object({ messageId: z.number().int().positive() }),
  'msg-history': z.object({
    channelId: id,
    before: z.number().int().positive().optional(),
    limit: z.number().int().min(1).max(LIMITS.historyPageMax).optional()
  }),
  'msg-read': z.object({ channelId: id, messageId: z.number().int().positive() }),
  'msg-search': z.object({
    query: z.string().trim().min(1, 'Пустой запрос').max(LIMITS.searchQueryLength, 'Слишком длинный запрос'),
    channelId: id.optional(),
    before: z.number().int().positive().optional(),
    limit: z.number().int().min(1).max(LIMITS.searchPage).optional()
  }),
  'status-set': z.object({ text: statusText.nullable() }),
  'dm-open': z.object({ userId: id }),
  'push-subscribe': z.object({
    subscription: z.object({
      endpoint: z.string().url().max(2048),
      keys: z.object({ p256dh: z.string().min(1).max(256), auth: z.string().min(1).max(256) })
    })
  }),
  'push-unsubscribe': z.object({ endpoint: z.string().max(2048) }),
  'status-presets-set': z.object({ presets: z.array(statusText).max(LIMITS.statusPresets, `Не больше ${LIMITS.statusPresets} статусов`) }),
  'role-create': z.object({ name: roleName, color: roleColor }),
  'role-update': z.object({ roleId: id, name: roleName.optional(), color: roleColor.optional() }),
  'role-delete': z.object({ roleId: id }),
  'role-assign': z.object({ userId: id, roleId: id, assigned: z.boolean() }),
  'profile-update': z.object({ nickname, avatar: fileId.nullable().optional() }),
  typing: z.object({ channelId: id }),

  'voice-join': z.object({ channelId: id }),
  'voice-ready': z.object({ rtpCapabilities: mediaJson }),
  'voice-leave': z.object({}),
  'voice-state-update': z.object({ muted: z.boolean(), deafened: z.boolean() }),
  'transport-create': z.object({ direction: z.enum(['send', 'recv']) }),
  'transport-connect': z.object({ transportId: id, dtlsParameters: mediaJson }),
  'transport-restart-ice': z.object({ transportId: id }),
  produce: z.object({
    transportId: id,
    kind: z.enum(['audio', 'video']),
    rtpParameters: mediaJson,
    source: z.enum(['mic', 'camera', 'screen', 'screen-audio']),
    paused: z.boolean().optional()
  }),
  'producer-close': z.object({ producerId: id }),
  'producer-pause': z.object({ producerId: id }),
  'producer-resume': z.object({ producerId: id }),
  consume: z.object({ producerId: id }),
  'consumer-resume': z.object({ consumerId: id }),
  'consumer-pause': z.object({ consumerId: id }),
  'admin-stats': z.object({}),
  'admin-settings': z.object({
    maxIncomingKbps: z.number().int().min(100).max(100_000).optional(),
    maxOutgoingKbps: z.number().int().min(0).max(1_000_000).optional(),
    maxUploadMb: z.number().int().min(1).max(10240).optional()
  }),
  'admin-kick': z.object({ userId: id, ban: z.boolean() }),
  'admin-unban': z.object({ userId: id }),
  'channel-create': z.object({ name: channelName, type: z.enum(['text', 'voice']) }),
  'channel-rename': z.object({ channelId: id, name: channelName }),
  'channel-delete': z.object({ channelId: id }),
  'channel-move': z.object({ channelId: id, direction: z.enum(['up', 'down']) }),
  'consumer-set-layers': z.object({
    consumerId: id,
    spatialLayer: z.number().int().min(0).max(3),
    temporalLayer: z.number().int().min(0).max(3).optional()
  })
} satisfies { [K in RequestType]: z.ZodType<RequestMap[K]> }

export function isRequestType(t: string): t is RequestType {
  return Object.prototype.hasOwnProperty.call(requestSchemas, t)
}

export type ParseResult<T> = { ok: true; data: T } | { ok: false; message: string }

export function parseRequest<K extends RequestType>(type: K, data: unknown): ParseResult<RequestMap[K]> {
  const schema = requestSchemas[type] as unknown as z.ZodType<RequestMap[K]>
  const res = schema.safeParse(data ?? {})
  if (res.success) return { ok: true, data: res.data }
  const issue = res.error.issues[0]
  const where = issue?.path?.length ? ` (${issue.path.join('.')})` : ''
  return { ok: false, message: (issue?.message ?? 'Неверный запрос') + where }
}
