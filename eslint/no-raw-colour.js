const PALETTE =
  'slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose'
const UTILITY =
  'bg|text|border|border-[xytrblse]|ring|ring-offset|outline|fill|stroke|from|via|to|decoration|divide|shadow|inset-shadow|drop-shadow|accent|caret|placeholder'
const PALETTE_CLASS = new RegExp(`(?:^|[\\s:'"\`])(?:${UTILITY})-(?:(?:${PALETTE})-\\d{2,3}|black|white)(?![\\w-])`)
const COLOUR_FUNCTION = /\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(/
const LONG_HEX = /#(?:[\da-f]{6}|[\da-f]{8})\b/i
const WHOLE_HEX = /^#(?:[\da-f]{3,4})$/i
const ARBITRARY_HEX = /\[#[\da-f]{3,8}\]/i

/** @param {string} text */
function isRawColour(text) {
  return (
    PALETTE_CLASS.test(text) ||
    COLOUR_FUNCTION.test(text) ||
    LONG_HEX.test(text) ||
    WHOLE_HEX.test(text.trim()) ||
    ARBITRARY_HEX.test(text)
  )
}

/** @type {import('eslint').Rule.RuleModule} */
export const noRawColour = {
  meta: {
    type: 'problem',
    docs: { description: 'Colours come from theme tokens, never palette classes or colour literals.' },
    schema: [],
    messages: {
      raw: 'Use a semantic colour token (see components/theme/themes/default.css), not a raw colour.',
    },
  },
  create(context) {
    return {
      Literal(node) {
        if (typeof node.value === 'string' && isRawColour(node.value)) {
          context.report({ node, messageId: 'raw' })
        }
      },
      TemplateElement(node) {
        if (isRawColour(node.value.raw)) {
          context.report({ node, messageId: 'raw' })
        }
      },
    }
  },
}
