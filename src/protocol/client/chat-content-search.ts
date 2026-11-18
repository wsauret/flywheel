import type { ChatSearchRequest, ChatSearchResult, FoundChat } from "../transcript-protocol-types.js"

/** The pause in typing after which a session list asks for chats by what was said in them. */
const CONTENT_SEARCH_DELAY_MS = 200

/** The chats whose messages match one query, best first; none after a failed search. */
export interface ContentAnswer {
  readonly query: string
  readonly chats: readonly FoundChat[]
}

interface ContentSearchDeps {
  readonly search: (request: ChatSearchRequest) => Promise<ChatSearchResult>
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
   *  already shows for the query by their titles. A blank query publishes undefined at once. */
  update(query: string, shown: readonly string[]): void
  dispose(): void
}

/** The content half of a session list search (PI-INTERACTION-178), shared by every client. Title matches are the
 *  client's own and show at once; this asks the runtime for the rest after a pause in typing, so the ranked
 *  search never runs per keystroke, and drops every answer that a later query has replaced. */
export function createContentSearch(deps: ContentSearchDeps): ContentSearch {
  let generation = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  const cancel = (): void => {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
  }
  async function run(query: string, exclude: readonly string[], mine: number): Promise<void> {
    try {
      const result = await deps.search({ query, exclude })
      if (mine === generation) deps.publish({ query, chats: result.chats })
    } catch (cause) {
      if (mine !== generation) return
      deps.publish({ query, chats: [] })
      deps.fail(cause)
    }
  }
  return {
    update(query, shown) {
      cancel()
      const mine = ++generation
      const text = query.trim()
      if (text.length === 0) {
        deps.publish(undefined)
        return
      }
      const exclude = [...shown]
      timer = setTimeout(() => { timer = undefined; void run(text, exclude, mine) }, deps.delayMs ?? CONTENT_SEARCH_DELAY_MS)
    },
    dispose() {
      cancel()
      generation++
    },
  }
}

/** True once the list has the content answer for `filter`, or needs none because the filter is blank. Until then a
 *  list with nothing to show says that it searches, not that nothing matches. */
export function contentSettled(answer: ContentAnswer | undefined, filter: string): boolean {
  const query = filter.trim()
  return query.length === 0 || answer?.query === query
}

/** The found chats a list shows under its title matches: those of the latest answer that are not title matches now.
 *  While a newer query waits for its answer, the previous answer's rows stay, so typing never empties the list or
 *  moves the selection off its row; the new answer replaces them in place. A blank filter publishes no answer and a
 *  failed search an empty one, so neither keeps older rows. */
export function contentRows(answer: ContentAnswer | undefined, shown: ReadonlySet<string>): readonly FoundChat[] {
  return answer === undefined ? [] : answer.chats.filter((chat) => !shown.has(chat.sessionId))
}
