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
  /** Source offset of its first word; absent when it has no words. */
  readonly start?: number
}

interface Builder {
  words: string[]
  shown: string[]
  opaque: boolean[]
  quoted: boolean[]
  starts: number[]
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
  const scanner = new ShellScanner()
  const parsed = scanner.advance(source).parsed
  return [...parsed, ...scanner.finish().parsed]
}

/** What one step of a `ShellScanner` completed. */
export interface ShellScanStep {
  /** Commands whose words ended in this step, in execution order. */
  readonly parsed: readonly ShellCommand[]
  /** Commands that ended in this step with the heredoc bodies they read, in
   *  execution order. A command that reads a heredoc ends its words before
   *  its body, and a body line ends no command. */
  readonly complete: readonly ShellCommand[]
  /** Commands whose words ended but which still wait for a heredoc body, in
   *  execution order, after the complete ones. */
  readonly waiting: readonly ShellCommand[]
  /** Where the top-level command or heredoc line being read starts. No
   *  command parsed later starts before it, and `slice` reads from it until
   *  the next step. It never moves behind the first character of the step
   *  that moves it: it moves only past a character that the step read. */
  readonly floor: number
}

/** A scan step: it yields each time it needs a character that has not
 *  arrived, and returns its result once it has read what it needs. */
type Scan<T = void> = Generator<void, T, void>

/** The `parseShell` scanner for a command that arrives in pieces: each
 *  `advance` reads only the appended text, and `finish` ends the source. The
 *  scanner suspends where it needs a character that has not arrived, so every
 *  construct, a quote or heredoc line included, resumes where it stopped. */
export class ShellScanner {
  private readonly commands: ShellCommand[] = []
  private readonly vars = new Map<string, string>()
  private readonly heredocs: { builder: Builder; delimiter: string; stripTabs: boolean }[] = []
  /** Commands that wait for their heredoc bodies before they are complete. */
  private readonly awaitingBody = new Set<ShellCommand>()
  private readonly run: Scan
  /** The unread source and the text the scan still slices: positions are
   *  absolute source offsets, and `window` starts at offset `base`. */
  private window = ""
  private base = 0
  private i = 0
  /** Where the top-level command or heredoc line being read starts; the
   *  window keeps text from here, since no scan state refers before it. */
  private floor = 0
  private ended = false
  private parsedCount = 0
  private completeCount = 0

  constructor() {
    this.run = this.list(undefined)
  }

  /** Reads the text appended to the source. */
  advance(text: string): ShellScanStep {
    if (this.floor > this.base) {
      this.window = this.window.slice(this.floor - this.base)
      this.base = this.floor
    }
    this.window += text
    this.run.next()
    return this.step()
  }

  /** Ends the source: a construct still open closes as it stands. */
  finish(): ShellScanStep {
    this.ended = true
    this.run.next()
    // A heredoc whose line never ended has no body to wait for.
    this.awaitingBody.clear()
    return this.step()
  }

  /** Source text between two absolute offsets that the scan has read since
   *  the top-level command or heredoc line it reads now started. */
  slice(from: number, to: number): string {
    return this.window.slice(from - this.base, to - this.base)
  }

  /** The absolute offset after the last source character. */
  get end(): number {
    return this.base + this.window.length
  }

  private step(): ShellScanStep {
    const parsed = this.commands.slice(this.parsedCount)
    this.parsedCount = this.commands.length
    const from = this.completeCount
    for (let next = this.commands[from]; next !== undefined && !this.awaitingBody.has(next); next = this.commands[this.completeCount]) this.completeCount++
    return { parsed, complete: this.commands.slice(from, this.completeCount), waiting: this.commands.slice(this.completeCount), floor: this.floor }
  }

  private at(k: number): string {
    return this.window.charAt(k - this.base)
  }

  /** Whether the character at `k` exists, suspending until it arrives or the source ends.
   *  @yields {void} While the character has not arrived. */
  private *has(k: number): Scan<boolean> {
    while (k >= this.end && !this.ended) yield
    return k < this.end
  }

  /** The offset of the next `char` from `from`, or the end of the source,
   *  reading each arriving character once.
   *  @yields {void} While no `char` has arrived and the source has not ended. */
  private *seek(char: string, from: number): Scan<number> {
    let scanned = from
    for (;;) {
      const found = this.window.indexOf(char, scanned - this.base)
      if (found >= 0) return found + this.base
      scanned = Math.max(scanned, this.end)
      if (this.ended) return this.end
      yield
    }
  }

  /** Read commands until the unquoted terminator of a substitution, or to the end.
   *  @yields {void} While the next character has not arrived. */
  private *list(terminator: ")" | "`" | undefined): Scan {
    const top = terminator === undefined
    let builder = this.builder(false)
    let depth = 0
    const endCommand = (pipedIn = false) => {
      this.closeCommand(builder)
      builder = this.builder(pipedIn)
      if (top) this.floor = this.i
    }
    while (this.i < this.end || (yield* this.has(this.i))) {
      const char = this.at(this.i)
      if (char === terminator && (terminator === "`" || depth === 0)) {
        this.i++
        break
      }
      if (char === "\\" && (yield* this.has(this.i + 1)) && this.at(this.i + 1) === "\n") this.i += 2
      else if (char === "\n") {
        this.i++
        endCommand()
        yield* this.readHeredocs(top)
      } else if (/\s/.test(char)) {
        // Every blank that ends a word separates words here, or a blank such
        // as a no-break space would end each word before it starts.
        this.i++
      } else if (char === "#") {
        while ((this.i < this.end || (yield* this.has(this.i))) && this.at(this.i) !== "\n") this.i++
      } else if (char === ";") {
        this.i += (yield* this.has(this.i + 1)) && this.at(this.i + 1) === ";" ? 2 : 1
        endCommand()
      } else if (char === "&" && (yield* this.has(this.i + 1)) && this.at(this.i + 1) === ">") yield* this.redirect(builder)
      else if (char === "&") {
        this.i += this.at(this.i + 1) === "&" ? 2 : 1
        endCommand()
      } else if (char === "|") {
        yield* this.has(this.i + 1)
        if (this.at(this.i + 1) === "|") {
          this.i += 2
          endCommand()
        } else {
          this.i += this.at(this.i + 1) === "&" ? 2 : 1
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
      } else if ((char === "<" || char === ">") && (yield* this.has(this.i + 1)) && this.at(this.i + 1) === "(") {
        const start = this.i
        this.i += 2
        yield* this.list(")")
        const written = this.slice(start, this.i)
        this.push(builder, { value: written, shown: written, opaque: true, quoted: false }, start)
      } else if (char === "<" || char === ">") yield* this.redirect(builder)
      else {
        const start = this.i
        const word = yield* this.word(terminator)
        const at = this.at(this.i)
        if (/^\d+$/.test(word.value) && !word.quoted && (at === "<" || at === ">")) yield* this.redirect(builder)
        else this.push(builder, word, start)
      }
    }
    this.closeCommand(builder)
  }

  private builder(pipedIn: boolean): Builder {
    return { words: [], shown: [], opaque: [], quoted: [], starts: [], pipedIn, pipedOut: false, writes: [] }
  }

  private push(builder: Builder, word: Word, start: number): void {
    builder.words.push(word.value)
    builder.shown.push(word.shown)
    builder.opaque.push(word.opaque)
    builder.quoted.push(word.quoted)
    builder.starts.push(start)
  }

  /** Read one redirection operator and its target.
   *  @yields {void} While the next character has not arrived. */
  private *redirect(builder: Builder): Scan {
    const both = this.at(this.i) === "&"
    if (both) this.i++
    const op = this.at(this.i)
    this.i++
    yield* this.has(this.i + 1)
    if (op === "<" && this.at(this.i) === "<" && this.at(this.i + 1) === "<") {
      this.i += 2
      yield* this.skipBlanks()
      builder.hereString = (yield* this.word(undefined)).value
      return
    }
    if (op === "<" && this.at(this.i) === "<") {
      this.i++
      const stripTabs = this.at(this.i) === "-"
      if (stripTabs) this.i++
      yield* this.skipBlanks()
      this.heredocs.push({ builder, delimiter: (yield* this.word(undefined)).value, stripTabs })
      return
    }
    if (op === ">" && (this.at(this.i) === ">" || this.at(this.i) === "|")) this.i++
    yield* this.has(this.i)
    if (this.at(this.i) === "&") {
      this.i++
      while ((yield* this.has(this.i)) && /[\d-]/.test(this.at(this.i))) this.i++
      return
    }
    yield* this.skipBlanks()
    const target = (yield* this.word(undefined)).value
    if (op === ">" && target !== "" && !OUTPUT_DEVICES.has(target.toLowerCase())) builder.writes.push(target)
  }

  private *skipBlanks(): Scan {
    while ((yield* this.has(this.i)) && (this.at(this.i) === " " || this.at(this.i) === "\t")) this.i++
  }

  /** Bodies of the heredocs the finished line opened, in the order it opened them.
   *  @yields {void} While the next body line has not arrived. */
  private *readHeredocs(top: boolean): Scan {
    for (const heredoc of this.heredocs.splice(0)) {
      const lines: string[] = []
      while (this.i < this.end || (yield* this.has(this.i))) {
        if (top) this.floor = this.i
        const end = yield* this.seek("\n", this.i)
        const line = this.slice(this.i, end)
        this.i = end < this.end ? end + 1 : end
        if ((heredoc.stripTabs ? line.replace(/^\t+/, "") : line) === heredoc.delimiter) break
        lines.push(line)
      }
      const command = heredoc.builder.command
      if (command !== undefined) {
        command.stdin = lines.join("\n")
        this.awaitingBody.delete(command)
      }
    }
    if (top) this.floor = this.i
  }

  private *word(terminator: ")" | "`" | undefined): Scan<Word> {
    let value = ""
    let shown = ""
    let opaque = false
    let quoted = false
    const add = (resolved: string, written = resolved) => {
      value += resolved
      shown += written
    }
    while (this.i < this.end || (yield* this.has(this.i))) {
      const char = this.at(this.i)
      if (/[\s;&|()<>]/.test(char) || char === terminator) break
      if (char === "'") {
        quoted = true
        const end = yield* this.seek("'", this.i + 1)
        add(this.slice(this.i + 1, end))
        this.i = end < this.end ? end + 1 : end
      } else if (char === '"') {
        quoted = true
        this.i++
        while ((this.i < this.end || (yield* this.has(this.i))) && this.at(this.i) !== '"') {
          const inner = this.at(this.i)
          if (inner === "\\" && (yield* this.has(this.i + 1)) && /["\\$`\n]/.test(this.at(this.i + 1))) {
            add(this.at(this.i + 1))
            this.i += 2
          } else if (inner === "$" || inner === "`") {
            const expansion = yield* this.expansion()
            add(expansion.value, expansion.shown)
            opaque ||= expansion.opaque
          } else {
            add(inner)
            this.i++
          }
        }
        this.i++
      } else if (char === "\\") {
        yield* this.has(this.i + 1)
        if (this.at(this.i + 1) !== "\n") add(this.at(this.i + 1))
        this.i += 2
      } else if (char === "$" || char === "`") {
        const expansion = yield* this.expansion()
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
   *  a variable the line assigned resolves to its value.
   *  @yields {void} While the next character has not arrived. */
  private *expansion(): Scan<Expansion> {
    const start = this.i
    const written = () => this.slice(start, this.i)
    if (this.at(this.i) === "`") {
      this.i++
      yield* this.list("`")
      return { value: written(), shown: written(), opaque: true }
    }
    yield* this.has(this.i + 2)
    const next = this.at(this.i + 1)
    if (next === "(" && this.at(this.i + 2) === "(") {
      let depth = 0
      for (this.i += 1; yield* this.has(this.i); this.i++) {
        if (this.at(this.i) === "(") depth++
        else if (this.at(this.i) === ")" && --depth === 0) break
      }
      this.i++
      return { value: written(), shown: written(), opaque: true }
    }
    if (next === "(") {
      this.i += 2
      yield* this.list(")")
      return { value: written(), shown: written(), opaque: true }
    }
    if (next === "{") {
      const end = yield* this.seek("}", this.i)
      this.i = end < this.end ? end + 1 : end
      return this.variable(this.slice(start + 2, end), written())
    }
    let nameEnd = this.i + 1
    while ((yield* this.has(nameEnd)) && (nameEnd > this.i + 1 ? /[A-Za-z0-9_]/ : /[A-Za-z_]/).test(this.at(nameEnd))) nameEnd++
    if (nameEnd > this.i + 1) {
      const name = this.slice(this.i + 1, nameEnd)
      this.i = nameEnd
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
  private closeCommand(builder: Builder): void {
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
    const firstWordStart = builder.starts[first]
    builder.command = {
      words: builder.words.slice(first),
      shown: builder.shown.slice(first),
      pipedIn: builder.pipedIn,
      pipedOut: builder.pipedOut,
      writes: builder.writes,
      ...(builder.hereString === undefined ? {} : { stdin: builder.hereString }),
      ...(firstWordStart === undefined ? {} : { start: firstWordStart }),
    }
    this.commands.push(builder.command)
    if (this.heredocs.some((heredoc) => heredoc.builder === builder)) this.awaitingBody.add(builder.command)
  }
}
