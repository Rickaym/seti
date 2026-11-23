import { attachmentDetail, type PromptAttachment } from '@seti/shared'
import { File, FileCode, FileText, Paperclip, RotateCw, TextCursorInput, X } from 'lucide-react'
import { useRef, type ReactNode } from 'react'
import { toast } from 'sonner'
import { errorText } from '@/api'
import { Hint } from '@/components/Hint'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { uploadingText, type Attachments } from '@/hooks/useAttachments'
import { stagedUrl, type DraftAttachment } from '@/lib/attachments'
import { percentOf, sentOf } from '@/lib/upload-state'
import { cn } from '@/lib/utils'
import { FileRefText } from '@/panels/files/FileRefText'
import { useFileLinks, useResolvedPath } from '@/panels/files/file-links'
import { rawUrl } from '@/panels/files/files-api'
import { UploadStatus } from '@/panels/tasks/UploadStatus'

const CHIP = 'flex h-8 max-w-80 min-w-0 items-center gap-1.5 border border-border bg-card pr-1 text-2xs'
/** A finger needs 44px, so a draft chip and its buttons grow on touch screens. */
const TOUCH_BUTTON = 'pointer-coarse:h-11 pointer-coarse:min-w-11'

function KindIcon({ kind, type }: { kind: DraftAttachment['kind']; type: string }) {
  const textIcon = type === 'Text' ? FileText : FileCode
  const Icon = kind === 'text' ? textIcon : File
  return <Icon className="ml-1.5 size-3.5 shrink-0 text-muted-foreground" />
}

function Thumb({ src, alt, className }: { src: string; alt: string; className?: string }) {
  return <img src={src} alt={alt} className={cn('size-8 shrink-0 border-r border-border object-cover', className)} />
}

const SHOWN_IMAGE = /^image\/(png|jpeg|gif|webp)$/

function chipPreview(item: DraftAttachment): string | null {
  if (item.kind !== 'image') {
    return null
  }
  const staged = item.staged !== null && SHOWN_IMAGE.test(item.staged.mime) ? stagedUrl(item.staged.id) : null
  return item.preview ?? staged
}

const BORDERS = { uploading: '', stalled: 'border-warning', failed: 'border-destructive' }

function DraftChip({ item, attachments }: { item: DraftAttachment; attachments: Attachments }) {
  const preview = chipPreview(item)
  const upload = attachments.uploads.get(item.key)
  const again = upload?.phase === 'stalled' || (upload?.phase === 'failed' && upload.failure.retry)
  return (
    <li
      className={cn(
        CHIP,
        'relative pointer-coarse:h-11',
        upload !== undefined && ['max-w-full', BORDERS[upload.phase]],
      )}
      aria-label={item.name}
    >
      {preview === null ? (
        <KindIcon kind={item.kind} type={item.type} />
      ) : (
        <Thumb src={preview} alt={item.name} className="pointer-coarse:size-11" />
      )}
      <span className={cn('max-w-40 truncate font-medium', upload === undefined ? 'shrink-0' : 'min-w-0')}>
        {item.name}
      </span>
      {upload === undefined ? (
        <span className="min-w-0 truncate text-muted-foreground">{item.staged !== null && attachmentDetail(item)}</span>
      ) : (
        <UploadStatus name={item.name} upload={upload} />
      )}
      {again && (
        <Hint text="Send the file again from the start">
          <Button
            variant="ghost"
            size="xs"
            aria-label={`Retry ${item.name}`}
            className={cn('px-1', TOUCH_BUTTON)}
            onClick={() => {
              attachments.retry(item.key)
            }}
          >
            <RotateCw />
            Retry
          </Button>
        </Hint>
      )}
      {item.staged?.source === 'paste' && (
        <Hint text="Put the text back into the message">
          <Button
            variant="ghost"
            size="xs"
            aria-label={`Inline ${item.name}`}
            className={cn('px-1', TOUCH_BUTTON)}
            onClick={() => {
              attachments.inline(item.key).catch((e: unknown) => {
                toast.error(errorText(e))
              })
            }}
          >
            <TextCursorInput />
            Inline
          </Button>
        </Hint>
      )}
      <Hint text={upload?.phase === 'uploading' ? 'Cancel the upload' : 'Drop the file'}>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={`Drop ${item.name}`}
          className={TOUCH_BUTTON}
          onClick={() => {
            attachments.drop(item.key)
          }}
        >
          <X />
        </Button>
      </Hint>
    </li>
  )
}

export function DraftAttachments({ attachments }: { attachments: Attachments }) {
  if (attachments.items.length === 0) {
    return null
  }
  const { overall } = attachments
  const moving = attachments.items.filter(
    (item) => item.staged === null && attachments.uploads.get(item.key)?.phase !== 'failed',
  )
  return (
    <>
      <ul aria-label="Attachments" className="flex flex-wrap gap-1.5">
        {attachments.items.map((item) => (
          <DraftChip key={item.key} item={item} attachments={attachments} />
        ))}
      </ul>
      {overall !== null && (
        <Progress
          value={percentOf(overall)}
          aria-label={uploadingText(moving.length)}
          aria-valuetext={`${String(percentOf(overall))}%, ${sentOf(overall)}`}
          className={moving.length > 1 ? 'h-0.5' : 'sr-only'}
        />
      )}
    </>
  )
}

/** Opens the file picker; phones offer the camera and photos there too. */
export function AttachButton({ onFiles, disabled = false }: { onFiles: (files: File[]) => void; disabled?: boolean }) {
  const input = useRef<HTMLInputElement>(null)
  return (
    <>
      <input
        ref={input}
        type="file"
        multiple
        hidden
        aria-label="Attach files"
        onChange={(e) => {
          const field = e.currentTarget
          onFiles([...(field.files ?? [])])
          field.value = ''
        }}
      />
      <Hint text="Attach files; you can also paste or drop them">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Attach"
          disabled={disabled}
          className="shrink-0 pointer-coarse:size-10"
          onClick={() => input.current?.click()}
        >
          <Paperclip />
        </Button>
      </Hint>
    </>
  )
}

/** A file sent with a prompt; opens in Files once the server finds it there. */
function SentChip({ taskId, file }: { taskId: string; file: PromptAttachment }) {
  const links = useFileLinks()
  const found = useResolvedPath(file.path)
  const thumb = file.kind === 'image' && found !== null ? rawUrl(taskId, found, { dotfiles: false }) : null
  const body = (
    <>
      {thumb === null ? <KindIcon kind={file.kind} type={file.type} /> : <Thumb src={thumb} alt={file.name} />}
      <span className="max-w-40 shrink-0 truncate font-medium">{file.name}</span>
      <span className="min-w-0 truncate pr-1 text-muted-foreground">{attachmentDetail(file)}</span>
    </>
  )
  if (links === null || found === null) {
    return (
      <span className={cn(CHIP, 'inline-flex align-middle')} title={file.path}>
        {body}
      </span>
    )
  }
  return (
    <button
      type="button"
      data-file-link={found.path}
      title={`Open ${file.path} in Files`}
      className={cn(CHIP, 'inline-flex cursor-pointer align-middle hover:bg-accent')}
      onClick={() => {
        links.open(found)
      }}
    >
      {body}
    </button>
  )
}

/** A prompt's text with each file reference shown as its chip. */
export function PromptText({
  taskId,
  text,
  files,
}: {
  taskId: string
  text: string
  files: readonly PromptAttachment[]
}) {
  const parts: ReactNode[] = []
  let rest = text
  for (const file of files) {
    const at = rest.indexOf(file.reference)
    if (at < 0) {
      continue
    }
    parts.push(
      <FileRefText key={`text-${file.path}`} text={rest.slice(0, at)} first={parts.length === 0} last={false} />,
      <SentChip key={file.path} taskId={taskId} file={file} />,
    )
    rest = rest.slice(at + file.reference.length)
  }
  parts.push(<FileRefText key="text-end" text={rest} first={parts.length === 0} last />)
  return <>{parts}</>
}

/** A draft file in a message not yet sent; it opens nowhere until the server places it. */
function PendingChip({ item }: { item: DraftAttachment }) {
  return (
    <span className={cn(CHIP, 'inline-flex align-middle')} title={item.name}>
      <KindIcon kind={item.kind} type={item.type} />
      <span className="max-w-40 shrink-0 truncate font-medium">{item.name}</span>
      <span className="min-w-0 truncate pr-1 text-muted-foreground">{attachmentDetail(item)}</span>
    </span>
  )
}

/** A pending message's text with each file token shown as its chip. */
export function PendingText({ text, files }: { text: string; files: readonly DraftAttachment[] }) {
  const parts: ReactNode[] = []
  let rest = text
  for (const file of files) {
    const at = rest.indexOf(file.token)
    if (at < 0) {
      continue
    }
    parts.push(
      <FileRefText key={`text-${file.key}`} text={rest.slice(0, at)} first={parts.length === 0} last={false} />,
      <PendingChip key={file.key} item={file} />,
    )
    rest = rest.slice(at + file.token.length)
  }
  parts.push(<FileRefText key="text-end" text={rest} first={parts.length === 0} last />)
  return <>{parts}</>
}
