# Reviewer persona detection benchmark results

Persona: reviewer-code-quality. Current decision evidence: the 2026-11-11 two-stage subscription sweep on the 31-task public corpus. Earlier evidence: the identity-complete 2026-09-10 Astra run (`reviewer-code-quality-2026-09-10T21-08-33-675Z`) and four-variant comparison run (`reviewer-code-quality-2026-09-10T22-20-33-465Z`). Both use the same nine fixtures, one repeat, reviewer guidance, gpt-5.6-sol judge, scoring version, profile, and Usage authority.

## Rerun: 2026-11-11 (public corpus, subscription sweep)

Method: a new public corpus of 31 tasks: defect fixtures derived from real reviews in size strata, plus 6 clean controls, with 52 labeled defects. Persona reviewer-code-quality. The judge is gpt-6.1-sol xhigh, which is also a candidate; a Claude opus high judge rescored 10 sol cells and agreed on 16 of 16 labels. Every reported candidate ran on a subscription with $0 billed; the stopped DeepSeek runs billed $0.19 through a fallback route. Stage 1 ran 15 settings with one repeat. Stage 2 ran the finalists with one more repeat.

Runs: stage 1 `reviewer-code-quality-2026-11-11T01-03-13-088Z` (non-Claude, scored by rescore), `reviewer-code-quality-2026-11-11T01-04-30-041Z` (Claude), `reviewer-code-quality-2026-11-11T05-15-25-509Z` (Fable); stage 2 `reviewer-code-quality-2026-11-11T15-32-09-950Z` (GPT, run from a clean worktree at `5097165ab`), `reviewer-code-quality-2026-11-11T06-50-30-346Z` (opus medium).

Pooled stages 1 and 2. Recall is of 104 labels, or 103 where one cell failed on provider overload. Control alarms are of 12 clean-control reviews. Cost is the list-equivalent cost per review.

| Variant | Recall | Control alarms | Cost/review | Avg latency |
|---|---:|---:|---:|---:|
| gpt-6.1-sol/xhigh | 91/104 (87.5%) | 3/12 | $0.47 | ~340s |
| gpt-5.6-terra/xhigh | 89/104 (85.6%) | 7/12 | $0.13 (lower bound: some entries unpriced) | ~120s |
| gpt-6.1-sol/high | 88/104 (84.6%) | 0/12 | $0.33 | ~180s |
| gpt-5.6-terra/high | 86/103 (83.5%) | 8/12 | $0.08 | ~60s |
| claude-opus-5.5/medium | 82/104 (78.8%) | 2/12 | $0.89 | ~150s |
| gpt-6.1-sol/medium | 79/104 (76.0%) | 0/12 | $0.23 | ~110s |
| gpt-5.6-terra/medium | 76/103 (73.8%) | 7/12 | $0.07 | ~50s |

Stage 1 only (one repeat, 52 labels):

| Variant | Recall | Cost/review |
|---|---:|---:|
| claude-fable-5.2/low | 82.7% | $1.43 |
| claude-sonnet-5.5/high | 69.2% | $0.48 |
| gpt-6-astra/low | 69.2% | $1.01 |
| claude-sonnet-5.5/low | 63.5% | $0.18 |
| claude-sonnet-5.5/medium | 59.6% | $0.21 |
| claude-opus-5.5/low | 57.7% | $0.34 |

DeepSeek v4.1 flash high and max stopped: its provider chain fell back to billed routes ($0.19) against the subscription-only rule, and it was 4 to 7 times slower. Grok was skipped by user decision.

Findings:

- Recall differences among the top five settings are within noise: 31 tasks give bootstrap intervals about 25 to 35 points wide per stage.
- Terra raised P1 or P2 findings on most clean controls. Sol high never did.
- 27 of the 52 labels were found originally by gpt-6-astra. Claude settings catch 88 to 100% of non-astra labels but 30 to 74% of astra labels, so part of the GPT lead may be label-source bias.

Decision (2026-11-11): the `reviewer-quality` role moves from gpt-6-astra medium to gpt-6.1-sol high, which is the shared `reviewer` default, so the role now inherits it. Its recall is within noise of the best, it raised no false alarms on clean code, and it costs about a third of astra's cost per review. gpt-5.6-terra xhigh is the cost-first alternative if false alarms can be filtered. `reviewer-elegance` and `reviewer-mechanism` stay on gpt-6-astra medium until an elegance-shaped corpus exists, because this corpus labels correctness defects only.

## Rerun: 2026-09-10

| Variant | Recall | Uncertain | Unsupported | Estimated equivalent | Billed | Avg latency |
|---|---:|---:|---:|---:|---:|---:|
| gpt-6-astra/low | 45/46 (97.8%) | 1 | 39 | $11.1471 | $0.0000 | 113s |
| claude-fable-5.1/low | 43/46 (93.5%) | 2 | 45 | $24.4249 | $24.4249 | 174s |
| gpt-5.6-terra/high | 43/46 (93.5%) | 2 | 25 | $4.0579 | $0.0000 | 193s |
| gpt-5.6-sol/medium | 41/46 (89.1%) | 3 | 42 | $7.1813 | $0.0000 | 219s |
| gpt-5.6-sol/low | 40/46 (87.0%) | 1 | 37 | $3.9298 | $0.0000 | 100s |

Decision (2026-09-10): the global `reviewer` seat uses gpt-5.6-terra high. The Quality, Elegance, and Mechanism specialist roles use gpt-6-astra low because they are the highest-impact review paths. Astra has the highest measured recall and catches two more defects than Terra. Quality has direct persona-benchmark evidence; Elegance and Mechanism remain provisional specialist assignments. Explicit user assignments remain unchanged. When Astra is unavailable, the specialists use the reviewer fixed default before tier inference.

The runs have matching task, guidance, judge, scoring, profile, and Usage-authority identities. Their campaign content identities differ only because the ordered variant matrix is part of each campaign identity. No repository or benchmark input changed between runs.

## Rerun: 2026-08-20 (cost-first default decision)

Run: `reviewer-code-quality-2026-08-20T19-48-29-977Z`: 4 variants x 7 fixtures x 2 repeats = 56 cells, 78 opportunities per variant, zero failed judge calls (4 cell attempts failed and were retried within the run). This is the first run after the luna provider optimizations and after the commit-pinned fixtures were repaired (repo-history rewrite had moved the pinned trees under `flywheel-tui/`; the manifests now pin subtree treeishes).

| Variant | Recall | Uncertain | Unsupported | Avg cost/run | Avg latency |
|---|---:|---:|---:|---:|---:|
| sol/medium | 71/78 (91.0%) | 6 | 89 | $1.10 | 163s |
| luna/xhigh | 68/78 (87.2%) | 3 | 74 | $0.16 | 243s |
| sol/low | 65/78 (83.3%) | 7 | 55 | $0.62 | 93s |
| luna/high | 64/78 (82.1%) | 7 | 77 | $0.09 | 156s |

Findings: sol/medium's 91.0% exactly reproduces the 2026-07-30 result. luna/xhigh's cost fell 4.3x for the same work (post-optimization) with recall within noise of its July number (87.2% vs 88.5%) and the fewest uncertain classifications. sol/low loses 8 recall points to sol/medium, so low effort is not a reviewer economy lever the way it is for the implementer seat.

Decision (2026-08-20): the global `reviewer` seat moves to gpt-5.6-luna xhigh as a cost-first default (87.2% at one seventh of sol/medium's per-review cost). gpt-5.6-sol medium remains the recall leader and the swap-back choice when review is the last line of defense. The step-scoped code-review seat and the Anthropic fallback are unchanged.

## Setup

Detection-recall scoring against seeded-defect fixtures in `fixtures/reviews/`, two classes:

- Three synthetic code fixtures (billing-ledger, sync-scheduler, cache-pagination): small self-contained TypeScript projects, 5 seeded behavioral defects each (float money accumulation, idempotency-key collisions, check-then-act races, unawaited flush on dispose, and similar).
- Four commit-pinned fixtures derived from real production workflows, materialized via `git archive` of this repository at the pinned commit so the reviewer works against the production-scale codebase. Two plan reviews (`provider-chain-plan`, 7 defects; `prompt-assets-plan`, 6 defects): real plan-handoff JSON with seeded mutations (false code claims, layering violations, parallel state, dropped invariants, spec contradictions). Two code reviews (`provider-chain-impl`, 5 defects reconstructed from a real production review's findings; `models-modal-impl`, 6 defects seeded into a real 45-file commit). Each fixture's WHY.md records provenance and defect rationale.

The judge (gpt-5.6-sol, pinned) awards a catch only when the review satisfies the manifest catch criteria. Unsupported findings count claimed defects with no basis.

## Results (2026-07-30 run, 78 opportunities per variant)

| Variant | Recall | Unsupported | Avg cost/run | Avg latency |
|---|---:|---:|---:|---:|
| sol/medium | 71/78 (91.0%) | 89 | $0.74 | 126s |
| opus-5/medium | 71/78 (91.0%) | 186 | $2.21 | 332s |
| luna/xhigh | 69/78 (88.5%) | 97 | $0.67 | 256s |
| luna/high | 69/78 (88.5%) | 72 | $0.38 | 134s |
| terra/high | 68/78 (87.2%) | 65 | $0.54 | 116s |
| terra/medium | 64/78 (82.1%) | 55 | $0.35 | 64s |
| fable-5/low | 62/78 (79.5%) | 83 | $1.76 | 165s |
| opus-4-8/medium | 59/78 (75.6%) | 45 | $1.11 | 224s |

By fixture class:

| Variant | Synthetic code (30) | Plan review (26) | Production code (22) |
|---|---:|---:|---:|
| sol/medium | 100% | 100% | 68% |
| opus-5/medium | 97% | 100% | 73% |
| terra/high | 97% | 88% | 73% |
| luna/xhigh | 97% | 96% | 68% |
| luna/high | 100% | 92% | 68% |
| terra/medium | 90% | 92% | 59% |
| fable-5/low | 90% | 85% | 59% |
| opus-4-8/medium | 90% | 65% | 68% |

## Conclusions

1. The production-scale fixtures discriminate where the synthetic ones saturate. On the old 3-fixture set every strong variant sits at 90-100%; on the new fixtures the spread is 18 points and the ranking reorders.
2. Reviewing competence splits by artifact class. Plan review rewards careful contradiction-hunting: sol/medium and opus-5/medium are perfect there. Production code review rewards runtime tracing through large diffs: terra/high and opus-5/medium lead at 73%, and sol/medium falls to the pack at 68%. terra/high has the smallest plan-to-code dropoff of any variant.
3. Effort on terra is not monotonically harmful in this seat: terra/high beats terra/medium overall (87.2% vs 82.1%) and decisively on production code review (73% vs 59%). The earlier "terra gets worse with effort in every seat" finding was a ceiling artifact of the synthetic fixtures.
4. opus-5/medium reaches top recall by spraying: 186 unsupported findings, 2-4x every other variant, at 3-6x the cost of the GPT leaders and the worst latency. It displaces opus-4-8/medium (75.6%, plan-blind at 65%) as the Anthropic fallback on recall, at a real precision and cost price.
5. fable-5/low is dominated on every axis and exits the candidate set.

## Decision

- Global `reviewer` seat (chat-context reviews, plan review, mixed contexts): gpt-5.6-terra medium -> gpt-5.6-sol medium. Best single compromise (91.0% overall, perfect on both plan fixtures, mid-pack precision).
- New step-agent seat `step.flywheel.code-review.agent.reviewer`: gpt-5.6-terra high. Tied-best production code-review recall at a quarter of opus-5's cost and a third of its latency. Plan review deliberately gets no step-scoped entry; it resolves to the global reviewer seat, which leads that class.
- Anthropic fallback for both seats: claude-opus-5 medium (recall parity with sol overall, best-in-class on both new fixture classes among Anthropic models). opus-4-8 gives up the fallback slot.

## Caveats

Two repeats per cell; single pinned judge. The per-class rankings rest on 22-26 opportunities per variant (2 fixtures x 2 repeats per class): the overall ranking is solid, the plan-vs-code specialization is directional. Adding 1-2 fixtures per class would firm it up. sol/medium's judge also scores its own variant's output (blind to identity). Unsupported-finding counts are judge-classified and noisy; opus-5's 186 is far enough outside the band to be a real signal.

The cross-model-review hypothesis (Anthropic eyes catch what OpenAI-authored code hides) remains untested: defects are seeded deliberately rather than emerging from a model's own blind spots.

## History

The 2026-07-23/24 runs (3 synthetic fixtures, 30 opportunities) ranked sol/medium 96.7%, luna/high 93.3%, terra/medium ~92%, terra/high 90.0%, opus-4-8/medium 90.0%, fable/low ~90%, sonnet-4-6/medium 80.0%, haiku-4-5/high 56.7%. The flat top band drove the original terra/medium decision on cost and latency; the 2026-07-30 run shows that flatness was fixture ceiling, not variant equivalence. Two scoring notes from that era stand: the first sol-vs-terra run (`...T20-44-31`) is invalid (harness scored only the handoff summary field; fixed since), and sonnet-5/medium is disqualified until the persona handoff contract is hardened (all 6 runs returned findings-free handoffs).
