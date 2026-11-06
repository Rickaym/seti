const MAX_LENGTH = 100
const DIRECTIVE = /^\s*(eslint[\s-]|global\s|globals\s|@ts-|\/\s*<reference\s)/
const NON_ASCII = /[^\x20-\x7E\t\n\r]/

/**
 * @param {import('estree').Comment} comment
 * @returns {import('estree').SourceLocation}
 */
function locationOf(comment) {
  if (!comment.loc) {
    throw new Error('ESLint comments always carry a location')
  }
  return comment.loc
}

/**
 * @param {import('estree').Comment} comment
 * @param {boolean} followsLineComment
 * @returns {('nonAscii' | 'tooLong' | 'block')[]}
 */
function violations(comment, followsLineComment) {
  const lines = comment.value.split('\n')
  const isDocstring = comment.type === 'Block' && comment.value.startsWith('*')
  /** @type {('nonAscii' | 'tooLong' | 'block')[]} */
  const found = []
  if (NON_ASCII.test(comment.value)) {
    found.push('nonAscii')
  }
  if (lines.some((line) => line.trim().length + 3 > MAX_LENGTH)) {
    found.push('tooLong')
  }
  if ((comment.type === 'Block' && !isDocstring && lines.length > 1) || followsLineComment) {
    found.push('block')
  }
  return found
}

/** @type {import('eslint').Rule.RuleModule} */
export const commentStyle = {
  meta: {
    type: 'suggestion',
    docs: { description: 'Comments are single lines, ASCII only and at most 100 characters.' },
    schema: [],
    messages: {
      nonAscii: 'Comments must be plain ASCII.',
      tooLong: `Comments must be at most ${String(MAX_LENGTH)} characters.`,
      block: 'Use one comment line. If the reason needs more, improve the name or write a docstring.',
    },
  },
  create(context) {
    return {
      Program() {
        let previousLineEnd = -1
        for (const comment of context.sourceCode.getAllComments()) {
          const loc = locationOf(comment)
          const isDirective = DIRECTIVE.test(comment.value)
          if (!isDirective) {
            const followsLineComment = comment.type === 'Line' && previousLineEnd === loc.start.line - 1
            for (const messageId of violations(comment, followsLineComment)) {
              context.report({ loc, messageId })
            }
          }
          previousLineEnd = comment.type === 'Line' && !isDirective ? loc.end.line : -1
        }
      },
    }
  },
}
