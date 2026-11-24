/** The node members the patcher compares and replaces before an element check. */
interface PatchedNode<Child> {
  readonly nodeType: number
  readonly nodeName: string
  nodeValue: string | null
  isEqualNode(other: Child): boolean
  replaceWith(other: Child): void
}

interface PatchedParent<Child> {
  readonly childNodes: ArrayLike<Child>
  readonly lastChild: { remove(): void } | null | undefined
  append(child: Child): void
}

/** Patches parsed Markdown after a settled prefix. Compatible elements and text
 * nodes stay resident; only new syntax, removed content, and changed node kinds
 * add or remove nodes. The caller supplies detached, already-safe markup. */
export function patchMarkdownChildren<Child extends PatchedNode<Child>>(parent: PatchedParent<NoInfer<Child>>, children: readonly Child[], start = 0): void {
  let index = start
  for (const next of children) {
    const current = parent.childNodes[index++]
    if (current === undefined) {
      parent.append(next)
    } else if (current.isEqualNode(next)) {
      continue
    } else if (current.nodeType !== next.nodeType || current.nodeName !== next.nodeName) {
      current.replaceWith(next)
    } else if (current.nodeType === 3) {
      current.nodeValue = next.nodeValue
    } else if (current instanceof Element && next instanceof Element) {
      for (const name of current.getAttributeNames()) {
        if (!next.hasAttribute(name)) current.removeAttribute(name)
      }
      for (const attribute of next.attributes) {
        if (current.getAttribute(attribute.name) !== attribute.value) current.setAttribute(attribute.name, attribute.value)
      }
      patchMarkdownChildren(current, [...next.childNodes])
    }
  }
  while (parent.childNodes.length > index) {
    parent.lastChild?.remove()
  }
}
