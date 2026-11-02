import { createRenderer } from "solid-js/universal"

interface HostProperties {
  [name: string]: unknown
}

interface Node {
  ownerDocument: typeof document
  tag?: string
  parent?: Node
  children: Node[]
  readonly childNodes: Node[]
  readonly parentNode: Node | null
  /** Whether the node's ancestors reach a mount's `root`, which stands in for the document. */
  readonly isConnected: boolean
  readonly nextSibling: Node | null
  contains(other: Node | null): boolean
  insertBefore(child: Node, before: Node | null): Node
  before(child: Node): void
  removeChild(child: Node): Node
  readonly lastChild: Node | undefined
  readonly nodeType: number
  readonly nodeName: string
  nodeValue: string | null
  innerHTML: string
  readonly content: Node
  readonly attributes: readonly { readonly name: string; readonly value: string }[]
  getAttributeNames(): string[]
  getAttribute(name: string): string | null
  hasAttribute(name: string): boolean
  setAttribute(name: string, value: string): void
  removeAttribute(name: string): void
  isEqualNode(other: Node): boolean
  append(child: Node): void
  replaceWith(child: Node): void
  text?: string
  properties: HostProperties
  scrollTop: number
  scrollHeight: number
  clientHeight: number
  /** Unbounded unless a fixture narrows it, so text measured against it always fits. */
  clientWidth: number
  readonly scrollWidth: number
  classList: { toggle(name: string, enabled: boolean): void; remove(name: string): void }
  offsetHeight: number
  style: { height: string; setProperty(name: string, value: string): void; removeProperty(name: string): string }
  focus(): void
  /** Selects a field's text, as an input that opens for editing asks; records the request under `properties.textSelected`. */
  select(): void
  /** The one DOM method components call on a ref; records the request under `properties.scrolledIntoView`. */
  scrollIntoView(options: unknown): void
  scrollTo(options: { top: number }): void
  remove(): void
  replaceChildren(): void
  insertAdjacentHTML(position: "beforeend", html: string): void
  /** The `data-*` properties by their camel-cased names, as an element's `dataset` reads them. */
  readonly dataset: { readonly [name: string]: string }
  querySelector(selector: string): Node | null
  /** Answers only `.row[data-block]`, the rows a transcript measures. */
  querySelectorAll(selector: string): Node[]
  closest(selector: string): Node | null
  getBoundingClientRect(): { top: number; bottom: number; height: number; width: number }
  addEventListener(type: string, listener: () => void): void
  removeEventListener(type: string, listener: () => void): void
  /** Calls each listener of `type` with `event`, such as a touch event's `{ touches }`. */
  dispatch(type: string, event?: unknown): void
}

let frameId = 0
const frames = new Map<number, FrameRequestCallback>()
/** Gives hand-built element trees a DOM-style element boundary without parsing markup. */
export function MemoryElement() {
  // The host assigns this prototype only to element nodes.
}
let activeElement: Node | null = null
const documentListeners = new Map<string, Set<(event: unknown) => void>>()
const document = {
  get activeElement() { return activeElement },
  set activeElement(value: Node | null) { activeElement = value },
  addEventListener(type: string, listener: (event: unknown) => void) {
    const listeners = documentListeners.get(type) ?? new Set()
    listeners.add(listener)
    documentListeners.set(type, listeners)
  },
  removeEventListener(type: string, listener: (event: unknown) => void) { documentListeners.get(type)?.delete(listener) },
  dispatch(type: string, event: unknown) { for (const listener of documentListeners.get(type) ?? []) listener(event) },
  /** A canvas whose text is 8 pixels per character, for components that measure text. */
  createElement: (tag: string) => tag === "canvas"
    ? { getContext: () => ({ font: "", measureText: (text: string) => ({ width: [...text].length * 8 }) }) }
    : createNode(tag),
  defaultView: {
    getComputedStyle: () => ({ font: "13px monospace", gap: "6" }),
    ResizeObserver: class {
      constructor(private readonly callback: (entries: readonly { readonly target: Node }[]) => void) {}
      observe() { this.callback([]) }
      unobserve() {}
      disconnect() {}
    },
    requestAnimationFrame(callback: FrameRequestCallback) {
      // OpenTUI installs process-global frame hooks that survive renderer disposal.
      // This document owns its browser frames independently of terminal tests.
      const id = ++frameId
      frames.set(id, callback)
      queueMicrotask(() => {
        const run = frames.get(id)
        frames.delete(id)
        run?.(0)
      })
      return id
    },
    cancelAnimationFrame(id: number) {
      frames.delete(id)
    },
  },
}

function createNode(tag: string | undefined, text?: string): Node {
  const listeners = new Map<string, Set<(event?: unknown) => void>>()
  const attributes = new Map<string, string>()
  const created: Node = {
    ownerDocument: document,
    children: [], properties: {}, scrollTop: 0, scrollHeight: 0, clientHeight: 0, clientWidth: Number.POSITIVE_INFINITY,
    get scrollWidth() {
      created.properties.widthReads = Number(created.properties.widthReads ?? 0) + 1
      return [...textContent(created)].length * 8
    },
    get childNodes() { return created.children },
    get parentNode() { return created.parent ?? null },
    get isConnected() {
      let node = created
      while (node.parent) node = node.parent
      return node.tag === "root"
    },
    get nextSibling() { return created.parent?.children[created.parent.children.indexOf(created) + 1] ?? null },
    contains(other) { return other !== null && nodes(created).includes(other) },
    insertBefore(child, before) {
      child.remove()
      child.parent = created
      created.children.splice(before === null ? created.children.length : created.children.indexOf(before), 0, child)
      return child
    },
    removeChild(child) { child.remove(); return child },
    before(child) { created.parent?.insertBefore(child, created) },
    get lastChild() { return created.children.at(-1) },
    get nodeType() { return tag === undefined ? 3 : 1 },
    get nodeName() { return tag ?? "#text" },
    get nodeValue() { return typeof created.properties.innerHTML === "string" ? created.properties.innerHTML : created.text ?? null },
    set nodeValue(value) {
      if (typeof created.properties.innerHTML === "string") created.properties.innerHTML = value
      else created.text = value ?? undefined
    },
    get content() { return created },
    get attributes() { return [...attributes].map(([name, value]) => ({ name, value })) },
    getAttributeNames: () => [...attributes.keys()],
    getAttribute: (name) => attributes.get(name) ?? null,
    hasAttribute: (name) => attributes.has(name),
    setAttribute(name, value) { attributes.set(name, value) },
    removeAttribute(name) { attributes.delete(name) },
    get innerHTML() { return textContent(created) },
    set innerHTML(html) {
      created.replaceChildren()
      if (html !== "") created.insertAdjacentHTML("beforeend", html)
    },
    isEqualNode(other) {
      return created.nodeName === other.nodeName && created.nodeValue === other.nodeValue
        && created.attributes.length === other.attributes.length
        && created.attributes.every(({ name, value }) => other.getAttribute(name) === value)
        && created.children.length === other.children.length
        && created.children.every((child, index) => child.isEqualNode(other.children[index]!))
    },
    append(child) {
      child.remove()
      child.parent = created
      created.children.push(child)
    },
    replaceWith(child) {
      const parent = created.parent
      if (parent === undefined) return
      child.remove()
      parent.children.splice(parent.children.indexOf(created), 1, child)
      created.parent = undefined
      child.parent = parent
    },
    remove() {
      if (created.parent) created.parent.children.splice(created.parent.children.indexOf(created), 1)
      created.parent = undefined
    },
    replaceChildren() {
      while (created.lastChild) created.lastChild.remove()
    },
    insertAdjacentHTML(_position, html) {
      // Markup stays opaque in this host; the browser owns its parsed element tree.
      const child = createNode(undefined)
      child.properties.innerHTML = html
      child.parent = created
      created.children.push(child)
    },
    classList: {
      remove(name) { created.classList.toggle(name, false) },
      toggle(name, enabled) {
        const classes = new Set(typeof created.properties.class === "string" ? created.properties.class.split(" ") : [])
        if (enabled) classes.add(name)
        else classes.delete(name)
        created.properties.class = [...classes].join(" ")
      },
    },
    get offsetHeight() { return created.getBoundingClientRect().height },
    set offsetHeight(height) { created.properties.rectHeight = height },
    style: {
      height: "",
      setProperty(name, value) { created.properties[`style:${name}`] = value },
      removeProperty(name) {
        const previous = created.properties[`style:${name}`]
        delete created.properties[`style:${name}`]
        return typeof previous === "string" ? previous : ""
      },
    },
    focus() { document.activeElement = created; created.properties.focused = true },
    select() { created.properties.textSelected = true },
    scrollIntoView(options) { created.properties.scrolledIntoView = options },
    scrollTo(options) { created.scrollTop = options.top },
    get dataset() {
      return Object.fromEntries(Object.entries(created.properties).flatMap(([name, value]) => name.startsWith("data-")
        ? [[name.slice(5).replace(/-(\w)/g, (_match, letter: string) => letter.toUpperCase()), String(value)]]
        : []))
    },
    querySelector(selector) {
      if (selector === '[data-active="true"]') return nodes(created).find((node) => node.properties["data-active"] === true) ?? null
      const row = /^\.row\[data-block="(.*)"\]$/.exec(selector)
      if (row !== null) return created.querySelectorAll(".row[data-block]").find((node) => node.properties["data-block"] === row[1]) ?? null
      return null
    },
    querySelectorAll(selector) {
      if (selector === '[role="menuitem"]') return nodes(created).filter(node => node.properties.role === "menuitem")
      if (selector !== ".row[data-block]") throw new Error(`Unsupported selector: ${selector}`)
      return nodes(created).filter((node) => node !== created && typeof node.properties["data-block"] === "string"
        && typeof node.properties.class === "string" && node.properties.class.split(" ").includes("row"))
    },
    closest(selector) {
      const classes = selector.split(",").map(value => value.trim().replace(/^\./, ""))
      for (let node: Node | undefined = created; node; node = node.parent) {
        const own = typeof node.properties.class === "string" ? node.properties.class.split(" ") : []
        if (classes.some(name => own.includes(name))) return node
      }
      return null
    },
    getBoundingClientRect() {
      const top = typeof created.properties.rectTop === "number" ? created.properties.rectTop : 0
      const height = typeof created.properties.rectHeight === "number" ? created.properties.rectHeight : created.tag === "section" ? 1 : 0
      return { top, bottom: top + height, height, width: created.scrollWidth }
    },
    addEventListener(type, listener) {
      const set = listeners.get(type) ?? new Set()
      set.add(listener)
      listeners.set(type, set)
    },
    removeEventListener(type, listener) { listeners.get(type)?.delete(listener) },
    dispatch(type, event) { for (const listener of listeners.get(type) ?? []) listener(event) },
    ...(tag === undefined ? {} : { tag }), ...(text === undefined ? {} : { text }),
  }
  if (tag !== undefined) Object.setPrototypeOf(created, MemoryElement.prototype)
  return created
}

/** An in-memory host for real Solid component updates, without a browser. */
export const {
  createElement, createTextNode, insertNode, insert, spread,
  setProp, mergeProps, effect, memo, createComponent, use,
} = createRenderer<Node>({
  createElement: (tag) => createNode(tag),
  createTextNode: (text) => createNode(undefined, text),
  replaceText: (node, text) => { node.text = text },
  setProperty: (node, name, value) => {
    if (name === "innerHTML" && typeof value === "string") node.innerHTML = value
    else node.properties[name] = value
  },
  insertNode(parent, node, anchor) {
    if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1)
    node.parent = parent
    const index = anchor ? parent.children.indexOf(anchor) : parent.children.length
    parent.children.splice(index, 0, node)
  },
  removeNode(parent, node) {
    parent.children.splice(parent.children.indexOf(node), 1)
    node.parent = undefined
  },
  isTextNode: (node) => node.text !== undefined,
  getParentNode: (node) => node.parent,
  getFirstChild: (node) => node.children[0],
  getNextSibling: (node) => node.parent?.children[node.parent.children.indexOf(node) + 1],
})

export function nodes(root: Node): Node[] {
  return [root, ...root.children.flatMap(nodes)]
}

export function textContent(root: Node): string {
  return `${root.text ?? ""}${typeof root.properties.innerHTML === "string" ? root.properties.innerHTML : ""}${root.children.map(textContent).join("")}`
}
