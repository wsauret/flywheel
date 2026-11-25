import type { ChatSearchRequest, ChatSearchResult, FoundChat } from "../../../transcript/transcript-protocol-types.js"

/** The pause in typing after which a session list asks for chats by what was said in them. */
const CONTENT_SEARCH_DELAY_MS = 200
/** The fewest letters that the word being typed needs before the messages are searched. The word matches as a
 *  prefix, and a shorter prefix matches so much of a large project's index that ranking it takes seconds. */
const CONTENT_SEARCH_MIN_PREFIX = 3

/** True when a chat search for `query` searches the messages: its last word, as the index splits words at
 *  punctuation, has at least `CONTENT_SEARCH_MIN_PREFIX` letters or digits. The runtime answers any other query with
 *  no chats, and a client does not send one while the person types. */
export function contentSearchable(query: string): boolean {
  const last = query.split(/[^\p{L}\p{N}]+/u).findLast((word) => word.length > 0)
  return last !== undefined && last.length >= CONTENT_SEARCH_MIN_PREFIX
}

/** The chats whose messages match one query, best first; none after a failed search. */
export interface ContentAnswer {
  readonly query: string
  readonly chats: readonly FoundChat[]
}

interface ContentSearchDeps {
  /** Runs one chat search. `signal` aborts once a later query or the list's end replaces the search, so the runtime
   *  can drop the work that remains. */
  readonly search: (request: ChatSearchRequest, signal: AbortSignal) => Promise<ChatSearchResult>
  /** Called with each answer that is still current, and with undefined when the query is blank. A failed search
   *  publishes no chats for its query, so no older query's rows stay. Between a new query and its answer, the last
   *  published answer stands. */
  readonly publish: (answer: ContentAnswer | undefined) => void
  /** Called with the failure of a search that is still current, after its empty answer. */
  readonly fail: (cause: unknown) => void
  readonly delayMs?: number
}

export interface ContentSearch {
  /** Ask, after the pause, for the chats whose messages match `query`, other than `shown`: the chats the list
   *  already shows for the query by their titles. A blank query publishes undefined at once. A query that is not
   *  `contentSearchable` asks nothing; the last answer stands while one of the two queries starts the other, as when
   *  the person types on or deletes back, and otherwise undefined is published at once. Each update cancels the
   *  search that it replaces, unless its words are those of that search. */
  update(query: string, shown: readonly string[]): void
  /** Ask the runtime to bring its message index current, so that the first search does not wait for it. A list
   *  calls this as it opens. The request is a search with a blank query, which answers no chats. */
  prepare(): void
  dispose(): void
}

/** The content half of a session list search (PI-INTERACTION-178), shared by every client. Title matches are the
 *  client's own and show at once; this asks the runtime for the rest after a pause in typing, so the ranked
 *  search never runs per keystroke, and cancels every search that a later query has replaced. */
export function createContentSearch(deps: ContentSearchDeps): ContentSearch {
  let generation = 0
  // The query of the latest search asked for, until a blank or unsearchable query replaces it. An update to the
  // same words, such as a trailing space, keeps that search.
  let asked: string | undefined
  // The query of the last published answer.
  let answered: string | undefined
  const publish = (answer: ContentAnswer | undefined): void => {
    answered = answer?.query
    deps.publish(answer)
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  let running: AbortController | undefined
  const lifetime = new AbortController()
  const cancel = (): void => {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
    running?.abort()
    running = undefined
  }
  async function run(query: string, exclude: readonly string[], mine: number): Promise<void> {
    const controller = new AbortController()
    running = controller
    try {
      const result = await deps.search({ query, exclude }, controller.signal)
      if (mine === generation) publish({ query, chats: result.chats })
    } catch (cause) {
      if (mine !== generation) return
      // The same words, asked again, search again.
      asked = undefined
      publish({ query, chats: [] })
      deps.fail(cause)
    } finally {
      if (running === controller) running = undefined
    }
  }
  return {
    update(query, shown) {
      const text = query.trim()
      if (text === asked) return
      cancel()
      const mine = ++generation
      asked = undefined
      if (text.length === 0) {
        publish(undefined)
        return
      }
      if (!contentSearchable(text)) {
        if (answered !== undefined && !text.startsWith(answered) && !answered.startsWith(text)) publish(undefined)
        return
      }
      asked = text
      const exclude = [...shown]
      timer = setTimeout(() => { timer = undefined; void run(text, exclude, mine) }, deps.delayMs ?? CONTENT_SEARCH_DELAY_MS)
    },
    prepare() {
      // A catch-up that fails costs nothing that a person sees: the next search catches up, or reports its failure.
      deps.search({ query: "", exclude: [] }, lifetime.signal).catch(() => undefined)
    },
    dispose() {
      asked = undefined
      cancel()
      lifetime.abort()
      generation++
    },
  }
}

/** What a list shows of the content half of its search for `filter`, under the title matches in `shown`. */
export interface ContentResults {
  /** The found chats of the latest answer that are not title matches now. While a newer query waits for its answer,
   *  the previous answer's rows stay, so typing never empties the list or moves the selection off its row; the new
   *  answer replaces them in place. A blank filter publishes no answer and a failed search an empty one, so neither
   *  keeps older rows. */
  readonly chats: readonly FoundChat[]
  /** True until the list has the answer for `filter`, unless it needs none because the filter is blank or not
   *  `contentSearchable`. Meanwhile a list with nothing to show says that it searches, not that nothing matches. */
  readonly searching: boolean
}

export function contentResults(answer: ContentAnswer | undefined, filter: string, shown: ReadonlySet<string>): ContentResults {
  const query = filter.trim()
  return {
    chats: answer === undefined ? [] : answer.chats.filter((chat) => !shown.has(chat.sessionId)),
    searching: query.length > 0 && contentSearchable(query) && answer?.query !== query,
  }
}
