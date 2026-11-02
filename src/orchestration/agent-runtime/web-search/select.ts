/**
 * Provider selection for the `web` tool: one capability facade over the
 * registered providers. The preference is pinned to the admitted request,
 * while provider availability is evaluated for each operation. When the
 * preferred provider is unavailable the other one serves, so a missing
 * credential degrades instead of disabling search.
 */

import { WebSearchError, type WebSearchPort, type WebSearchProvider, type WebSearchProviderId } from "./types.js";

export interface CreateWebSearchOptions {
  /** Providers captured from one enabled module composition. */
  providers: readonly WebSearchProvider[];
  /** Preference captured with the admitted provider request. */
  preference?: WebSearchProviderId;
}

export function createWebSearch(options: CreateWebSearchOptions): WebSearchPort {
  const providers = options.providers;
  const preference = options.preference ?? "chatgpt";

  function select(): WebSearchProvider | undefined {
    const preferred = preference;
    const ordered = [...providers].sort((a, b) => Number(b.id === preferred) - Number(a.id === preferred));
    return ordered.find((provider) => provider.available());
  }

  return {
    available: () => select() !== undefined,
    run(command, runOptions) {
      const provider = select();
      if (!provider) {
        return Promise.reject(new WebSearchError("no web search provider is available: connect ChatGPT or Exa in /auth"));
      }
      return provider.run(command, runOptions);
    },
  };
}
