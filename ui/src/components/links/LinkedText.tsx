import { LinkPill } from '@/components/links/LinkPill'
import { urlPieces } from '@/lib/links/bare-urls'
import { pillOf } from '@/lib/links/link-label'

/** Plain text with each bare http or https URL in it shown as a link pill. */
export function LinkedText({ text }: { text: string }) {
  return (
    <>
      {urlPieces(text).map((piece, index) => {
        const info = pillOf(piece.href)
        return info === null || piece.href === undefined ? (
          piece.text
        ) : (
          <LinkPill key={index} href={piece.href} info={info} />
        )
      })}
    </>
  )
}
