/** One simple command of a shell line, as far as a display needs it. The
 *  parser is for presentation only: it never fails, and a construct it does
 *  not model degrades to plain words instead of hiding the command. */
export interface ShellCommand {
  /** Words with every variable the line defines substituted. */
  readonly words: readonly string[]
  /** The same words with their expansions kept as written, for a command
   *  that presents as itself. */
  readonly shown: readonly string[]
  /** Its standard input comes from the command before it in a pipeline. */
  readonly pipedIn: boolean
  /** Its standard output feeds the command after it in a pipeline. */
  readonly pipedOut: boolean
  /** Files its output redirections create or append to. */
  readonly writes: readonly string[]
  /** The body of a heredoc or here-string it reads. */
  readonly stdin?: string
}

interface Builder {
  words: string[]
  shown: string[]
  opaque: boolean[]
  quoted: boolean[]
  pipedIn: boolean
  pipedOut: boolean
  writes: string[]
  hereString?: string
  /** The command this builder pushed, so a heredoc body read after the line ends reaches it. */
  command?: { -readonly [K in keyof ShellCommand]: ShellCommand[K] }
}

interface Expansion {
  readonly value: string
  readonly shown: string
  readonly opaque: boolean
}

interface Word {
  readonly value: string
  readonly shown: string
  readonly opaque: boolean
  readonly quoted: boolean
}

const OUTPUT_DEVICES = new Set(["/dev/null", "/dev/stdout", "/dev/stderr", "/dev/tty", "nul", "$null"])
const LEADING_KEYWORDS = new Set(["do", "then", "else", "elif", "if", "while", "until", "!", "{"])
const CLOSING_KEYWORDS = new Set(["done", "fi", "esac", "}"])
const DECLARATIONS = new Set(["export", "local", "declare", "readonly", "typeset"])
const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=/

/** Split a shell line into its simple commands, in execution order: the
 *  commands of a substitution come before the command that uses its output. */
export function parseShell(source: string): readonly ShellCommand[] {
  const scanner = new Scanner(source)
  scanner.list(undefined)
  return scanner.commands
}

class Scanner {
  readonly commands: ShellCommand[] = []
  private readonly vars = new Map<string, string>()
  private readonly heredocs: { builder: Builder; delimiter: string; stripTabs: boolean }[] = []
  private i = 0

  constructor(private readonly src: string) {}

  /** Read commands until the unquoted terminator of a substitution, or to the end. */
  list(terminator: ")" | "`" | undefined): void {
    const src = this.src
    let builder = this.builder(false)
    let depth = 0
    const endCommand = (pipedIn = false) => {
      this.finish(builder)
      builder = this.builder(pipedIn)
    }
    while (this.i < src.length) {
      const char = src.charAt(this.i)
      if (char === terminator && (terminator === "`" || depth === 0)) {
        this.i++
        break
      }
      if (char === " " || char === "\t" || char === "\r") this.i++
      else if (char === "\\" && src.charAt(this.i + 1) === "\n") this.i += 2
      else if (char === "\n") {
        this.i++
        endCommand()
        this.readHeredocs()
      } else if (char === "#") {
        while (this.i < src.length && src.charAt(this.i) !== "\n") this.i++
      } else if (char === ";") {
        this.i += src.charAt(this.i + 1) === ";" ? 2 : 1
        endCommand()
      } else if (char === "&" && src.charAt(this.i + 1) === ">") this.redirect(builder)
      else if (char === "&") {
        this.i += src.charAt(this.i + 1) === "&" ? 2 : 1
        endCommand()
      } else if (char === "|") {
        if (src.charAt(this.i + 1) === "|") {
          this.i += 2
          endCommand()
        } else {
          this.i += src.charAt(this.i + 1) === "&" ? 2 : 1
          builder.pipedOut = true
          endCommand(true)
        }
      } else if (char === "(") {
        this.i++
        depth++
        endCommand()
      } else if (char === ")") {
        this.i++
        depth = Math.max(0, depth - 1)
        endCommand()
      } else if ((char === "<" || char === ">") && src.charAt(this.i + 1) === "(") {
        const start = this.i
        this.i += 2
        this.list(")")
        this.push(builder, { value: src.slice(start, this.i), shown: src.slice(start, this.i), opaque: true, quoted: false })
      } else if (char === "<" || char === ">") this.redirect(builder)
      else {
        const word = this.word(terminator)
        const at = src.charAt(this.i)
        if (/^\d+$/.test(word.value) && !word.quoted && (at === "<" || at === ">")) this.redirect(builder)
        else this.push(builder, word)
      }
    }
    this.finish(builder)
  }

  private builder(pipedIn: boolean): Builder {
    return { words: [], shown: [], opaque: [], quoted: [], pipedIn, pipedOut: false, writes: [] }
  }

  private push(builder: Builder, word: Word): void {
    builder.words.push(word.value)
    builder.shown.push(word.shown)
    builder.opaque.push(word.opaque)
    builder.quoted.push(word.quoted)
  }

  /** Read one redirection operator and its target. */
  private redirect(builder: Builder): void {
    const src = this.src
    const both = src.charAt(this.i) === "&"
    if (both) this.i++
    const op = src.charAt(this.i)
    this.i++
    if (op === "<" && src.startsWith("<<", this.i)) {
      this.i += 2
      this.skipBlanks()
      builder.hereString = this.word(undefined).value
      return
    }
    if (op === "<" && src.charAt(this.i) === "<") {
      this.i++
      const stripTabs = src.charAt(this.i) === "-"
      if (stripTabs) this.i++
      this.skipBlanks()
      this.heredocs.push({ builder, delimiter: this.word(undefined).value, stripTabs })
      return
    }
    if (op === ">" && (src.charAt(this.i) === ">" || src.charAt(this.i) === "|")) this.i++
    if (src.charAt(this.i) === "&") {
      this.i++
      while (/[\d-]/.test(src.charAt(this.i))) this.i++
      return
    }
    this.skipBlanks()
    const target = this.word(undefined).value
    if (op === ">" && target !== "" && !OUTPUT_DEVICES.has(target.toLowerCase())) builder.writes.push(target)
  }

  private skipBlanks(): void {
    while (this.src.charAt(this.i) === " " || this.src.charAt(this.i) === "\t") this.i++
  }

  /** Bodies of the heredocs the finished line opened, in the order it opened them. */
  private readHeredocs(): void {
    const src = this.src
    for (const heredoc of this.heredocs.splice(0)) {
      const lines: string[] = []
      while (this.i < src.length) {
        const end = src.indexOf("\n", this.i)
        const line = src.slice(this.i, end < 0 ? src.length : end)
        this.i = end < 0 ? src.length : end + 1
        if ((heredoc.stripTabs ? line.replace(/^\t+/, "") : line) === heredoc.delimiter) break
        lines.push(line)
      }
      if (heredoc.builder.command !== undefined) heredoc.builder.command.stdin = lines.join("\n")
    }
  }

  private word(terminator: ")" | "`" | undefined): Word {
    const src = this.src
    let value = ""
    let shown = ""
    let opaque = false
    let quoted = false
    const add = (resolved: string, written = resolved) => {
      value += resolved
      shown += written
    }
    while (this.i < src.length) {
      const char = src.charAt(this.i)
      if (/[\s;&|()<>]/.test(char) || char === terminator) break
      if (char === "'") {
        quoted = true
        const end = src.indexOf("'", this.i + 1)
        add(src.slice(this.i + 1, end < 0 ? src.length : end))
        this.i = end < 0 ? src.length : end + 1
      } else if (char === '"') {
        quoted = true
        this.i++
        while (this.i < src.length && src.charAt(this.i) !== '"') {
          const inner = src.charAt(this.i)
          if (inner === "\\" && /["\\$`\n]/.test(src.charAt(this.i + 1))) {
            add(src.charAt(this.i + 1))
            this.i += 2
          } else if (inner === "$" || inner === "`") {
            const expansion = this.expansion()
            add(expansion.value, expansion.shown)
            opaque ||= expansion.opaque
          } else {
            add(inner)
            this.i++
          }
        }
        this.i++
      } else if (char === "\\") {
        if (src.charAt(this.i + 1) !== "\n") add(src.charAt(this.i + 1))
        this.i += 2
      } else if (char === "$" || char === "`") {
        const expansion = this.expansion()
        add(expansion.value, expansion.shown)
        opaque ||= expansion.opaque
      } else {
        add(char)
        this.i++
      }
    }
    return { value, shown, opaque, quoted }
  }

  /** One `$` or backtick expansion. A substitution's commands join the line;
   *  a variable the line assigned resolves to its value. */
  private expansion(): Expansion {
    const src = this.src
    const start = this.i
    const written = () => src.slice(start, this.i)
    if (src.charAt(this.i) === "`") {
      this.i++
      this.list("`")
      return { value: written(), shown: written(), opaque: true }
    }
    const next = src.charAt(this.i + 1)
    if (next === "(" && src.charAt(this.i + 2) === "(") {
      let depth = 0
      for (this.i += 1; this.i < src.length; this.i++) {
        if (src.charAt(this.i) === "(") depth++
        else if (src.charAt(this.i) === ")" && --depth === 0) break
      }
      this.i++
      return { value: written(), shown: written(), opaque: true }
    }
    if (next === "(") {
      this.i += 2
      this.list(")")
      return { value: written(), shown: written(), opaque: true }
    }
    if (next === "{") {
      const end = src.indexOf("}", this.i)
      this.i = end < 0 ? src.length : end + 1
      return this.variable(src.slice(start + 2, end < 0 ? src.length : end), written())
    }
    const name = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(this.i + 1))?.[0]
    if (name !== undefined) {
      this.i += 1 + name.length
      return this.variable(name, written())
    }
    this.i += /[?@#*$!\-0-9]/.test(next) ? 2 : 1
    return { value: written(), shown: written(), opaque: written() !== "$" }
  }

  private variable(name: string, written: string): Expansion {
    const known = this.vars.get(name)
    return known === undefined ? { value: written, shown: written, opaque: true } : { value: known, shown: written, opaque: false }
  }

  /** Close one simple command: drop shell grammar, record assignments and
   *  loop variables, and keep what runs. */
  private finish(builder: Builder): void {
    let start = 0
    while (start < builder.words.length && !builder.quoted[start] && LEADING_KEYWORDS.has(builder.words[start] ?? "")) start++
    const words = builder.words.slice(start)
    const head = words[0] ?? ""
    if (head === "for" && !builder.quoted[start]) {
      const name = words[1] ?? ""
      if (words[2] === "in") this.vars.set(name, words.slice(3).join(", "))
      else this.vars.delete(name)
      return
    }
    if (words.length === 1 && CLOSING_KEYWORDS.has(head)) {
      // A group or loop that redirects its output writes that file itself.
      if (builder.writes.length > 0) this.commands.push({ words: [], shown: [], pipedIn: builder.pipedIn, pipedOut: builder.pipedOut, writes: builder.writes })
      return
    }
    const declared = DECLARATIONS.has(head) && !builder.quoted[start] ? 1 : 0
    let at = start + declared
    while (at < builder.words.length && ASSIGNMENT.test(builder.words[at] ?? "")) at++
    if (at === builder.words.length && (at > start + declared || declared === 1)) {
      for (let k = start + declared; k < at; k++) {
        const word = builder.words[k] ?? ""
        const name = ASSIGNMENT.exec(word)?.[1] ?? ""
        if (builder.opaque[k]) this.vars.delete(name)
        else this.vars.set(name, word.slice(name.length + 1))
      }
      if (builder.writes.length === 0) return
    }
    const first = declared === 1 ? builder.words.length : at
    if (first === builder.words.length && builder.writes.length === 0) return
    builder.command = {
      words: builder.words.slice(first),
      shown: builder.shown.slice(first),
      pipedIn: builder.pipedIn,
      pipedOut: builder.pipedOut,
      writes: builder.writes,
      ...(builder.hereString === undefined ? {} : { stdin: builder.hereString }),
    }
    this.commands.push(builder.command)
  }
}
