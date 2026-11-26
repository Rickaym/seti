import type { Nodes } from 'mdast'

const MAX_URL = 8192

/** An http or https URL a reference can cite. */
export function isWebUrl(url: string): boolean {
  if (url.length > MAX_URL || !URL.canParse(url)) {
    return false
  }
  const { protocol } = new URL(url)
  return protocol === 'http:' || protocol === 'https:'
}

const isMark = (node: Nodes) => node.type === 'text' && node.data?.hName === 'sup'

function pieces(node: Nodes, skip: Nodes | null): string[] {
  if (node === skip || isMark(node)) {
    return []
  }
  if (node.type === 'text' || node.type === 'inlineCode') {
    return [node.value]
  }
  if (node.type === 'break') {
    return [' ']
  }
  if (!('children' in node)) {
    return []
  }
  return (node.children as Nodes[]).flatMap((child) => [...pieces(child, skip), child.type === 'paragraph' ? ' ' : ''])
}

/** The words under `node` on one line, without reference marks and without `skip`. */
export const plainText = (node: Nodes, skip: Nodes | null = null): string =>
  pieces(node, skip).join('').replace(/\s+/g, ' ').trim()
