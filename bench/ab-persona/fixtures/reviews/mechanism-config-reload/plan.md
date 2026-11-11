# Plan: apply configuration changes without a restart

## Goal

Operators edit `config.json` to change rate limits and feature flags. Today a change needs a process restart, which drops in-flight requests. After this plan, the server applies a saved edit within about one second and keeps serving.

## Current behavior this plan relies on

- `ConfigStore.current()` is the only way components read configuration, and `ConfigStore.reload(text)` already swaps the snapshot atomically (config.ts).
- The rate limiter reads `config.current().limits` on every `allow()` call, so a new `requestsPerMinute` or `burst` applies to the next request once the snapshot is swapped (limiter.ts). No limiter change is needed.
- The request handler receives a getter, not a value, so feature flags are read per request and a reloaded flag applies to the next request (handler.ts, server.ts).
- A reload whose text fails parsing or validation throws and leaves the previous snapshot in place, even though `withDefaults` mutates the config it receives (config.ts).
- Listeners registered with `onChange` run after the swap, so a listener that calls `current()` sees the new snapshot (config.ts).

## Steps

1. Add `watch.ts` with `watchConfig(path, store)`. It uses `fs.watch` on the file, debounces events by 250 ms, reads the file, and calls `store.reload(text)`.
2. On `ConfigError`, log one warning with the error message and keep serving with the previous snapshot. Do not retry until the next file event.
3. Call `watchConfig` from `startServer` after the store is created, and close the watcher on shutdown.
4. Add an `onChange` listener that logs the applied limits so operators can confirm a change took effect.

## Tests

- Unit: reload with valid text changes `current()`; reload with invalid text throws and `current()` is unchanged.
- Unit: the limiter allows `requestsPerMinute` requests, then after a reload that doubles it, allows the doubled count in the next window.
- Integration: edit the file on disk and observe a flag change through the handler within one second.

## Out of scope

Reloading the listen port or TLS certificates.
