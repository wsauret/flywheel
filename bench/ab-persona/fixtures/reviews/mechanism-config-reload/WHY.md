# mechanism-config-reload: claim ground truth

Plan review. Four claims: 1 is false, 2, 3, and 4 are true. Claims 2 and 3 look doubtful on a skim, and claim 3 sits next to the false claim 1 so that a reviewer who refutes both by analogy is penalized.

## Claim 1: FALSE (label limiter-captures-limits-at-startup)

createRateLimiter runs `const { requestsPerMinute, burst } = config.current().limits;` once, in the factory body (limiter.ts:18), outside the returned `allow` closure. allow computes its budget from those captured constants (limiter.ts:32-33) and never calls `current()`. startServer builds the limiter once at startup (server.ts:8). After `reload` swaps the snapshot (config.ts:55-58), the limiter still enforces the startup limits. The probe built a limiter at 2 requests per minute, reloaded to 5, and the limiter still allowed only 2 in a fresh window while `current()` reported 5. The plan's statement that "no limiter change is needed" is wrong; the limiter must read `current()` inside allow or subscribe through onChange.

## Claim 2: TRUE (looks doubtful)

`withDefaults` mutates its argument (config.ts:26-30), which suggests the live snapshot could be changed in place. It is never given the live snapshot: `build` calls it on the object that `parseConfig` just created with JSON.parse (config.ts:65-68). `reload` assigns `this.snapshot` only after `build` returns (config.ts:56-57). Any throw in parseConfig (config.ts:20, config.ts:22) or validate (config.ts:34-35) leaves `this.snapshot` untouched, and every such throw is a ConfigError, as the reload doc comment (config.ts:53-54) and plan step 2 expect: parseConfig rejects valid JSON that is not an object, such as `null`, a number, or an array, before withDefaults can touch it (config.ts:22). The probe sent invalid JSON, a negative limit, a burst above the limit, `null`, and `[]`; all threw ConfigError, and `current()` still returned the same object with intact limits.

## Claim 3: TRUE (looks doubtful)

createHandler takes `settings: () => Config` (handler.ts:15) and calls it inside the per-request closure (handler.ts:18). startServer passes the getter `() => config.current()` (server.ts:9), not a snapshot value. Each request therefore reads the current snapshot. The probe returned 404 for `/search` before a reload that enabled the flag and 200 after.

## Claim 4: TRUE

`reload` assigns `this.snapshot = next` (config.ts:57) before the listener loop (config.ts:58), and `current()` returns `this.snapshot` (config.ts:49-50). The probe's listener read 42 through `current()` after a reload to 42.
