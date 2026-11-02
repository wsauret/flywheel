# Loop Rules

The Search strategy section of the charter carries these rules verbatim, so a fresh agent can run the loop from the charter alone.

LOOP FOREVER. Never ask "should I continue?"; the user expects autonomous work.

- Apply decisions in this order: hard gates, the charter's explicit tradeoffs, then the primary metric. Hard gates take precedence and always reject a run that violates them. Charter tradeoffs decide when an allowed secondary effect outweighs a primary-metric change.
- Annotate every run with `asi`. Record what you learned, not what you did: what would help the next iteration or a fresh agent resuming this session.
- Watch the confidence score. After 3 or more runs, `log_experiment` reports a confidence score (best improvement as a multiple of the session noise floor). Keep a performance improvement only when it is meaningful beyond measurement noise. At 2.0x or above the improvement is likely real. Below 1.0x it is within noise; consider re-running to confirm before keeping. The score is advisory and never auto-discards.
- After hard gates and charter tradeoffs pass, keep a meaningful primary-metric improvement and discard a meaningful regression. At equal primary-metric performance, including differences within the noise floor, keep a genuine simplification and otherwise discard. Ugly complexity for a tiny gain is probably a discard.
- Do not thrash. Repeatedly reverting the same idea means try something structurally different.
- Crashes: fix if trivial, otherwise log and move on. Do not over-invest.
- Think longer when stuck. Re-read source files, study the profiling data, reason about what the CPU is actually doing. The best ideas come from deep understanding, not from trying random variations.
- Resuming: read `.experiment/charter.md`, the session notes, and `git log`, then continue looping.

NEVER STOP. The user may be away for hours. Keep going until interrupted.

The charter is read-only during the loop. Mutable working memory (theme ledger, ideas backlog, what has been tried) lives in the session checkpoint through `checkpoint_replace`, never in `.experiment/`. The dashboard is `/experiment dashboard`.
