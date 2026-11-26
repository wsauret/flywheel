import { decodeHTMLAttribute, decodeHTMLStrict } from "entities/decode"
import hljs from "highlight.js/lib/common"
import { Marked, type Token } from "marked"

/** Renders model output.
 *
 *  Everything passing through here is untrusted: it is model text, tool output,
 *  and file contents. The webview's CSP already refuses inline script, but a
 *  renderer that emits raw HTML would still allow markup that lies about the
 *  interface, so HTML in the source is escaped rather than passed through.
 *  Links allow HTTP(S), mail, telephone, and relative destinations. Other
 *  schemes and invalid URLs render only their formatted labels. An image on
 *  another host renders as a link to it: an inline image would make the
 *  client fetch from any host the text names, which tells that host the
 *  reader's address and when they read. An image the client holds (`data:`,
 *  `blob:`) or a relative path to its own origin stays inline.
 *
 *  Streaming makes the second problem: half a fence, an unterminated bold, an
 *  incomplete link. The live block is reparsed on every token so a partially
 *  arrived document renders as the finished one will, rather than flickering
 *  through broken intermediate states; the blocks before it are settled and
 *  rendered once (see `createMarkdownStream`). */
const marked = new Marked({
  gfm: true,
  breaks: false,
  // Escaped, not sanitized after the fact: nothing downstream has to be trusted
  // to strip the right things.
  async: false,
})

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

// The base classifies relative destinations only; it never enters the output.
const RELATIVE_BASE = new URL("https://flywheel.invalid/")

/** A destination as Marked's token holds it, decoded once and parsed. Marked
 *  keeps character references in href tokens, so the decoded value is what
 *  both the URL parser and the escaped attribute use. */
function destinationOf(href: string) {
  const decoded = decodeHTMLAttribute(href)
  try {
    return { decoded, url: new URL(decoded, RELATIVE_BASE) }
  } catch {
    return { decoded, url: undefined }
  }
}

function titleAttribute(title: string | null | undefined): string {
  // Marked preserves complete title entities, but escapes incomplete ones.
  return title ? ` title="${escapeHtml(decodeHTMLStrict(title))}"` : ""
}

/** A link to `href` around `label`, which is already markup, or `label`
 *  alone when the destination is not one the policy above allows. */
function linkHtml(href: string, title: string | null | undefined, label: string): string {
  const { decoded, url } = destinationOf(href)
  if (url === undefined || !["http:", "https:", "mailto:", "tel:"].includes(url.protocol)) return label
  return `<a href="${escapeHtml(decoded)}"${titleAttribute(title)}>${label}</a>`
}

/** The tokens of a link label or an image description, with every image
 *  replaced by its description and every link by its label at any depth, so
 *  the markup they render holds no link that would nest inside another. */
function labelTokens(tokens: readonly Token[]): Token[] {
  return tokens.flatMap((token): Token[] => {
    if (token.type === "image" || token.type === "link") return labelTokens(token.tokens ?? [])
    return "tokens" in token && token.tokens ? [{ ...token, tokens: labelTokens(token.tokens) }] : [token]
  })
}

marked.use({
  renderer: {
    link({ href, title, tokens }) {
      const label = labelTokens(tokens)
      // A label with no visible text shows the address, so the link can be seen.
      const visible = this.parser.parseInline(label, this.parser.textRenderer).trim().length > 0
      return linkHtml(href, title, visible ? this.parser.parseInline(label) : escapeHtml(decodeHTMLAttribute(href)))
    },
    image({ href, title, tokens }) {
      const description = labelTokens(tokens)
      const text = this.parser.parseInline(description, this.parser.textRenderer).trim()
      const { decoded, url } = destinationOf(href)
      const inline = url !== undefined && (url.protocol === "data:" || url.protocol === "blob:" || url.origin === RELATIVE_BASE.origin)
      if (inline) return `<img src="${escapeHtml(decoded)}" alt="${escapeHtml(text)}"${titleAttribute(title)}>`
      const remote = url !== undefined && (url.protocol === "http:" || url.protocol === "https:")
      const label = text.length > 0 ? this.parser.parseInline(description) : remote ? escapeHtml(decoded) : "image"
      return remote ? linkHtml(href, title, label) : label
    },
    html(token) {
      // Raw HTML in model output renders as the text it is.
      return escapeHtml(typeof token === "string" ? token : token.raw)
    },
    code(token) {
      const language = typeof token === "string" ? undefined : token.lang
      const text = typeof token === "string" ? token : token.text
      const known = language && hljs.getLanguage(language) ? language : undefined
      const body = known
        ? hljs.highlight(text, { language: known, ignoreIllegals: true }).value
        : escapeHtml(text)
      const label = known ? `<span class="code-lang">${escapeHtml(known)}</span>` : ""
      // The copy button is plain markup here and acts through the view's one
      // delegated click, since this HTML is inserted, not rendered.
      return `<pre class="code"><span class="code-tools">${label}<button type="button" class="code-copy" aria-label="Copy code">Copy</button></span><code>${body}</code></pre>`
    },
  },
})

/** One advance of a document that is still arriving. */
interface MarkdownStep {
  /** True when the source no longer extends what was settled, so everything
   *  rendered so far is stale and this step's markup replaces it. */
  readonly reset: boolean
  /** Markup for the blocks this advance settled, to append after what was
   *  already emitted. Empty when no block completed. */
  readonly settledHtml: string
  /** Markup for the live tail, replacing the previous advance's tail. */
  readonly tailHtml: string
}

export interface MarkdownStream {
  advance(source: string): MarkdownStep
}

/** Renders a document that is still arriving, one settled block at a time.
 *
 *  A streaming reply is re-rendered on every token. Parsing the whole document
 *  and rebuilding all of its markup each time costs time proportional to its
 *  length, so a long plan being written makes every token dearer than the
 *  last, and a phone stalls under it. A top-level block cannot change once
 *  another block follows it: nothing in Markdown reaches back across a block
 *  boundary except an unterminated fence, which is itself the last block. So
 *  each advance lexes only the text after the settled prefix, emits the markup
 *  of the blocks that just settled once, and renders the last block alone. */
export function createMarkdownStream(): MarkdownStream {
  let settled = ""
  return {
    advance(source) {
      const reset = !source.startsWith(settled)
      if (reset) settled = ""
      const tokens = marked.lexer(source.slice(settled.length))
      // The last block is live. Trailing blank lines belong to it: a blank line
      // after a paragraph does not finish it as far as a following heading
      // underline or list is concerned.
      let cut = tokens.length
      while (cut > 0 && tokens[cut - 1]?.type === "space") cut -= 1
      cut = Math.max(0, cut - 1)
      const settledTokens = tokens.slice(0, cut)
      for (const token of settledTokens) settled += token.raw
      return { reset, settledHtml: marked.parser(settledTokens), tailHtml: marked.parser(tokens.slice(cut)) }
    },
  }
}

/** Highlights a standalone body such as a tool result or a file preview, where
 *  the content is code rather than prose. */
export function renderCode(source: string, filetype?: string): string {
  const known = filetype && hljs.getLanguage(filetype) ? filetype : undefined
  return known ? hljs.highlight(source, { language: known, ignoreIllegals: true }).value : escapeHtml(source)
}

/** Renders a unified diff with per-line intent. The runtime already computed
 *  the patch; this only colours what it produced. */
export function renderDiff(patch: string): string {
  // A patch ends in a newline; the empty string after it is not a context row.
  const lines = patch.replace(/\n$/, "").split("\n")
  const body = lines
    .filter((line) => !line.startsWith("---") && !line.startsWith("+++") && !line.startsWith("Index:") && !line.startsWith("==="))
    .map((line) => {
      const kind = line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : line.startsWith("@@") ? "hunk" : "ctx"
      return `<div class="diff-line diff-${kind}">${escapeHtml(line)}</div>`
    })
    .join("")
  return `<div class="diff">${body}</div>`
}

