import type { StreamParser, StringStream } from '@codemirror/language'
import { tags } from '@lezer/highlight'

const TARGET = /^[\w.%/$()-]+(?=\s*:)/
const ASSIGN = /^[A-Za-z_][\w.-]*(?=\s*[:+?!]{0,2}=)/
const DIRECTIVE =
  /^-?(?:ifeq|ifneq|ifdef|ifndef|else|endif|include|sinclude|define|endef|export|unexport|override|vpath)\b/
const REFERENCE = /^\$(?:\([^)]*\)|\{[^}]*\}|[@<^?*%+|$])/
const STRING = /^"(?:[^"\\]|\\.)*"?|^'[^']*'?/

const eat = (stream: StringStream, pattern: RegExp) => Boolean(stream.match(pattern))

function lineStart(stream: StringStream): string | null {
  if (eat(stream, DIRECTIVE)) {
    return 'keyword'
  }
  return eat(stream, ASSIGN) || eat(stream, TARGET) ? 'key' : null
}

/** Makefiles: the targets and variables they define, directives, references, strings, comments. */
export const makefile: StreamParser<null> = {
  name: 'makefile',
  tokenTable: { key: tags.propertyName },
  token(stream) {
    if (stream.sol()) {
      const start = lineStart(stream)
      if (start !== null) {
        return start
      }
    }
    if (stream.eat('#') !== undefined) {
      stream.skipToEnd()
      return 'comment'
    }
    if (eat(stream, REFERENCE)) {
      return 'atom'
    }
    if (eat(stream, STRING)) {
      return 'string'
    }
    stream.next()
    stream.eatWhile(/[^\s#$"']/)
    return null
  },
}
