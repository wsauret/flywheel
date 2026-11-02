/** The call a test's network stand-in answers: `fetch`'s own parameters. */
type FetchHandler = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

/** Gives a test's network stand-in the whole `fetch` type, for a global
 *  replacement or an injected `fetch` port. Calls go to `handler` unchanged;
 *  `preconnect` throws, because no code under test may open a real socket. */
export function fakeFetch(handler: FetchHandler): typeof fetch {
  return Object.assign((input: string | URL | Request, init?: RequestInit) => handler(input, init), {
    preconnect: (url: string | URL): never => { throw new Error(`a test fetch does not preconnect to ${String(url)}`) },
  })
}
