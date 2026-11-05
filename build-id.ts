/**
 * Метка сборки для экрана настроек: по ней видно, какая именно версия работает на устройстве
 * (приложение обновляется установщиком, веб-версия — вместе с сервером).
 */
import { execSync } from 'node:child_process'

export function buildId(): string {
  const date = new Date().toISOString().slice(0, 16).replace('T', ' ')
  let rev = (process.env.GITHUB_SHA ?? '').slice(0, 7)
  if (!rev) {
    try {
      rev = execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
    } catch {
      /* сборка вне git (например, в Docker) — остаётся только дата */
    }
  }
  return rev ? `${rev} · ${date} UTC` : `${date} UTC`
}
