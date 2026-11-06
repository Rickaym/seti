import { tagHighlighter, tags as t } from '@lezer/highlight'

/** Syntax tags and the token classes App.css colours, shared by the editors and code blocks. */
export const syntaxHighlighter = tagHighlighter([
  { tag: [t.keyword, t.modifier, t.tagName, t.operatorKeyword], class: 'tok-keyword' },
  { tag: [t.string, t.regexp, t.escape, t.attributeValue, t.special(t.string)], class: 'tok-string' },
  { tag: [t.number, t.bool, t.null, t.atom, t.self, t.unit, t.color], class: 'tok-literal' },
  {
    tag: [
      t.function(t.variableName),
      t.function(t.propertyName),
      t.className,
      t.propertyName,
      t.attributeName,
      t.typeName,
      t.labelName,
    ],
    class: 'tok-function',
  },
  { tag: t.comment, class: 'tok-comment' },
  { tag: t.inserted, class: 'tok-inserted' },
  { tag: t.deleted, class: 'tok-deleted' },
  { tag: [t.meta, t.heading], class: 'tok-meta' },
])
