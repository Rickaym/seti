import { LinkedText } from '@/components/links/LinkedText'
import { textPieces } from '@/lib/file-paths'
import { FileLink } from '@/panels/files/FileLink'
import { useFileLinks } from '@/panels/files/file-links'

/** Plain text, such as the user's own message, with file references as chips and URLs as pills. */
export function FileRefText({ text, first, last }: { text: string; first: boolean; last: boolean }) {
  const links = useFileLinks()
  if (links === null) {
    return <LinkedText text={text} />
  }
  return (
    <>
      {textPieces(text, { first, last }).map((piece) =>
        piece.ref === null ? (
          <LinkedText key={piece.start} text={piece.text} />
        ) : (
          <FileLink key={piece.start} path={piece.ref} card={piece.card}>
            {piece.text}
          </FileLink>
        ),
      )}
    </>
  )
}
