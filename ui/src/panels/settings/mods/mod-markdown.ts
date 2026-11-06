import type { Nodes, Root } from 'mdast'

/** An image as a link to it, so a mod's README never loads a picture from a host it names. */
function withoutImages(node: Nodes): Nodes {
  if (node.type === 'image') {
    return { type: 'link', url: node.url, children: [{ type: 'text', value: node.alt ?? node.url }] }
  }
  if (node.type === 'imageReference') {
    return { type: 'text', value: node.alt ?? '' }
  }
  if (!('children' in node)) {
    return node
  }
  return { ...node, children: (node.children as Nodes[]).map(withoutImages) } as Nodes
}

/** A remark plugin that shows each image in a mod's Markdown as a link instead. */
export const remarkNoImages = () => (tree: Root) => withoutImages(tree) as Root
