import { useEffect, useState, type SyntheticEvent } from 'react'
import { useTranslation } from 'react-i18next'
import type { FileInfo } from '../../../shared/types'
import { fileUrl, formatDuration, formatSize } from '../lib/files'
import { setApp, useApp } from '../store/app'
import { notifyPageMedia, notifyPageMediaPlaying } from '../store/voice'
import { CloseIcon, DownloadIcon, FileIcon } from './Icons'

const MAX_W = 400
const MAX_H = 300

/** Размер превью с сохранением пропорций (чтобы лента не прыгала при загрузке картинки). */
function fit(w: number | null, h: number | null, maxW = MAX_W, maxH = MAX_H): { width: number; height: number } | undefined {
  if (!w || !h) return undefined
  const scale = Math.min(1, maxW / w, maxH / h)
  return { width: Math.round(w * scale), height: Math.round(h * scale) }
}

function download(f: FileInfo): void {
  const url = fileUrl(f.id, { download: true })
  if (url) void window.zvon.downloadFile(url)
}

export function Attachments({ files }: { files: FileInfo[] }) {
  useApp((s) => s.fileToken) // ссылки содержат токен — перерисовываемся при его смене
  if (files.length === 0) return null
  const images = files.filter((f) => f.kind === 'image')
  return (
    <div className="attachments">
      {files.map((f) => {
        if (f.kind === 'image') return <ImageAttachment key={f.id} file={f} gallery={images} />
        if (f.kind === 'video') return <VideoAttachment key={f.id} file={f} />
        if (f.kind === 'audio') return <AudioAttachment key={f.id} file={f} />
        return <FileCard key={f.id} file={f} />
      })}
    </div>
  )
}

function ImageAttachment({ file, gallery }: { file: FileInfo; gallery: FileInfo[] }) {
  const { t } = useTranslation()
  const [error, setError] = useState(false)
  const src = fileUrl(file.thumbId ?? file.id)
  const size = fit(file.width, file.height)
  if (!src || error) {
    return (
      <div className="attach-error">
        {t('files.imageError')} · <button onClick={() => download(file)}>{t('files.download')}</button>
      </div>
    )
  }
  return (
    <button className="attach-image" style={size} onClick={() => setApp({ lightbox: { file, gallery } })} title={file.name}>
      <img src={src} alt={file.name} loading="lazy" draggable={false} onError={() => setError(true)} style={size} />
    </button>
  )
}

/**
 * Видео и аудио из чата сообщают звонку, что играют: после остановки звонок восстанавливает свой звук
 * (на iPhone система забирает его у звонка). Каждый элемент учитывается не больше одного раза.
 */
const playingMedia = new WeakSet<HTMLMediaElement>()

function mediaStarted(el: HTMLMediaElement): void {
  if (playingMedia.has(el)) return
  playingMedia.add(el)
  notifyPageMedia(true, el)
}

function mediaStopped(el: HTMLMediaElement): void {
  if (!playingMedia.delete(el)) return
  notifyPageMedia(false, el)
}

const callFriendlyMedia = {
  onPlay: (e: SyntheticEvent<HTMLMediaElement>) => mediaStarted(e.currentTarget),
  // Звук реально пошёл: на iPhone в этот момент звонок возвращает себе голос собеседников поверх видео.
  onPlaying: (e: SyntheticEvent<HTMLMediaElement>) => notifyPageMediaPlaying(e.currentTarget),
  onPause: (e: SyntheticEvent<HTMLMediaElement>) => mediaStopped(e.currentTarget),
  onEnded: (e: SyntheticEvent<HTMLMediaElement>) => mediaStopped(e.currentTarget),
  onEmptied: (e: SyntheticEvent<HTMLMediaElement>) => mediaStopped(e.currentTarget),
  // Элемент убрали со страницы прямо во время воспроизведения (сообщение удалили, канал сменили).
  ref: (el: HTMLMediaElement | null) => {
    if (!el) return
    return () => mediaStopped(el)
  }
}

function VideoAttachment({ file }: { file: FileInfo }) {
  const { t } = useTranslation()
  const [error, setError] = useState(false)
  const src = fileUrl(file.id)
  const poster = file.thumbId ? (fileUrl(file.thumbId) ?? undefined) : undefined
  const size = fit(file.width, file.height, 480, 360)
  return (
    <div className="attach-video" style={size ? { width: size.width } : undefined}>
      {error ? (
        <div className="attach-error">{t('files.cantPlay')}</div>
      ) : (
        <video
          src={src ?? undefined}
          poster={poster}
          controls
          playsInline
          preload="metadata"
          style={size}
          onError={() => setError(true)}
          {...callFriendlyMedia}
        />
      )}
      <div className="attach-meta">
        <span className="attach-name" title={file.name}>
          {file.name}
        </span>
        <span>
          {formatSize(file.size)}
          {file.duration ? ` · ${formatDuration(file.duration)}` : ''}
        </span>
        <button className="icon-btn" title={t('files.download')} onClick={() => download(file)}>
          <DownloadIcon width={16} height={16} />
        </button>
      </div>
    </div>
  )
}

function AudioAttachment({ file }: { file: FileInfo }) {
  const { t } = useTranslation()
  const src = fileUrl(file.id)
  return (
    <div className="attach-file attach-audio">
      <div className="attach-meta">
        <FileIcon width={22} height={22} />
        <span className="attach-name" title={file.name}>
          {file.name}
        </span>
        <span>{formatSize(file.size)}</span>
        <button className="icon-btn" title={t('files.download')} onClick={() => download(file)}>
          <DownloadIcon width={16} height={16} />
        </button>
      </div>
      <audio src={src ?? undefined} controls preload="metadata" {...callFriendlyMedia} />
    </div>
  )
}

function FileCard({ file }: { file: FileInfo }) {
  const { t } = useTranslation()
  return (
    <div className="attach-file">
      <FileIcon width={30} height={30} className="attach-file-icon" />
      <div className="attach-file-text">
        <button className="link-btn attach-name" title={t('files.download')} onClick={() => download(file)}>
          {file.name}
        </button>
        <span className="attach-size">{formatSize(file.size)}</span>
      </div>
      <button className="icon-btn" title={t('files.download')} onClick={() => download(file)}>
        <DownloadIcon width={20} height={20} />
      </button>
    </div>
  )
}

/** Просмотр картинки на весь экран с листанием и скачиванием. */
export function Lightbox() {
  const { t } = useTranslation()
  const state = useApp((s) => s.lightbox)
  useApp((s) => s.fileToken)

  useEffect(() => {
    if (!state) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setApp({ lightbox: null })
      const i = state.gallery.findIndex((f) => f.id === state.file.id)
      if (e.key === 'ArrowLeft' && i > 0) setApp({ lightbox: { ...state, file: state.gallery[i - 1] } })
      if (e.key === 'ArrowRight' && i >= 0 && i < state.gallery.length - 1) setApp({ lightbox: { ...state, file: state.gallery[i + 1] } })
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [state])

  if (!state) return null
  const { file, gallery } = state
  const i = gallery.findIndex((f) => f.id === file.id)
  const src = fileUrl(file.id)
  return (
    <div className="lightbox" onMouseDown={(e) => e.target === e.currentTarget && setApp({ lightbox: null })}>
      <div className="lightbox-bar">
        <span className="lightbox-name">
          {file.name} · {formatSize(file.size)}
          {file.width && file.height ? ` · ${file.width}×${file.height}` : ''}
        </span>
        <button className="icon-btn" title={t('files.download')} onClick={() => download(file)}>
          <DownloadIcon width={20} height={20} />
        </button>
        <button className="icon-btn" title={t('files.close')} onClick={() => setApp({ lightbox: null })}>
          <CloseIcon width={22} height={22} />
        </button>
      </div>
      {i > 0 && (
        <button className="lightbox-nav prev" title={t('files.prev')} onClick={() => setApp({ lightbox: { ...state, file: gallery[i - 1] } })}>
          ‹
        </button>
      )}
      {src && <img className="lightbox-img" src={src} alt={file.name} draggable={false} />}
      {i >= 0 && i < gallery.length - 1 && (
        <button className="lightbox-nav next" title={t('files.next')} onClick={() => setApp({ lightbox: { ...state, file: gallery[i + 1] } })}>
          ›
        </button>
      )}
    </div>
  )
}
