/**
 * Журнал звука: последние события звонка (микрофон, воспроизведение, видео из чата, перезаходы).
 * Нужен, чтобы разбираться с проблемами на устройствах, которых нет под рукой (например, iPhone):
 * человек открывает настройки, копирует журнал и присылает его.
 */
const MAX_LINES = 120
const lines: string[] = []
const listeners = new Set<() => void>()

function stamp(): string {
  const d = new Date()
  const p = (n: number, w = 2): string => String(n).padStart(w, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`
}

export function diag(message: string): void {
  lines.push(`${stamp()} ${message}`)
  if (lines.length > MAX_LINES) lines.splice(0, lines.length - MAX_LINES)
  for (const l of listeners) l()
}

/** Короткое описание ошибки для журнала. */
export function errText(err: unknown): string {
  const e = err as { name?: string; message?: string }
  return e?.name ? `${e.name}: ${e.message ?? ''}` : String(err)
}

type AudioSessionLike = { type?: string; state?: string }

/** Журнал целиком, с шапкой об устройстве и сборке. */
export function diagText(): string {
  const session = (navigator as Navigator & { audioSession?: AudioSessionLike }).audioSession
  const head = [
    `Zvon ${__ZVON_VERSION__} (${__ZVON_BUILD__})${__ZVON_WEB__ ? ', веб' : ', приложение'}`,
    navigator.userAgent,
    `audioSession: ${session ? `${session.type ?? '?'} / ${session.state ?? '?'}` : 'нет'}; страница: ${document.visibilityState}`
  ]
  return [...head, '', ...(lines.length ? lines : ['(событий пока нет)'])].join('\n')
}

export function onDiag(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
