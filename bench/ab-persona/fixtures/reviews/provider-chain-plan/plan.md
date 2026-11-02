{
  "schema_version": 1,
  "summary": "Implement ordered, quota-aware access-provider chains for unpinned roles, with process-local Copilot and ChatGPT availability tracking, terminal-quota-only stream failover, stable session notices, an optional Copilot monthly cap in global TOML and Settings, accurate provider audit data, focused unit coverage, standard repository gates, and installed-binary tmux UAT.",
  "context": {
    "key_files": [
      "src/infra/llm/access-provider.ts - Canonical provider definitions, configured predicates, family support, current preference logic, and provider error copy builders.",
      "src/orchestration/agent-runtime/llm/client-factory.ts - Single production seam that currently chooses one provider and maps all stream errors through `fromStreamError`.",
      "src/orchestration/agent-runtime/shared/llm/retry.ts - Existing same-provider retry policy; it already replays a stream even after partial assistant output has been emitted, so chain failover can replay unconditionally at the same seam.",
      "src/orchestration/agent-runtime/shared/llm/provider-failure.ts - Shared raw-provider classifier that must gain a terminal quota tag without altering other retry tags.",
      "src/orchestration/agent-runtime/llm/openai-helpers.ts - Existing OpenAI and ChatGPT response-failure code classification.",
      "src/orchestration/agent-runtime/llm/copilot.ts - Copilot credential refresh, custom fetch, static headers, and Redacted token boundary.",
      "src/orchestration/agent-runtime/llm/openai-chatgpt.ts - ChatGPT custom fetch that can passively inspect successful and failed ChatGPT HTTP response headers.",
      "src/orchestration/agent-runtime/llm/copilot-model-support.ts - Runtime-specific Copilot model and endpoint support table.",
      "src/orchestration/session-role-resolver.ts - Current code that turns an omitted provider into a scalar snapshot and would accidentally pin automatic roles.",
      "src/orchestration/session/schemas.ts - Durable role assignment schema that currently requires a provider string.",
      "src/orchestration/config/schema.ts - Global TOML schema and recognized top-level keys.",
      "src/orchestration/config/writer.ts - Atomic text-preserving config mutation patterns for root and nested settings.",
      "src/tui/hooks/use-settings-modal.ts - Settings row, editor draft, validation, writer, and toast ownership.",
      "src/infra/session-notice.ts - Stable session notice upsert, same-scope replacement, and projection semantics.",
      "src/orchestration/agent-runtime/shared/provider-request-audit.ts - `model.requested` writer that currently captures one provider at runtime assembly.",
      "src/orchestration/workflow-deps.ts - Runtime composition point that loads global config and creates the agent runtime.",
      "tests/unit/orchestration/config/model-listing-access-provider.test.ts - Deliberate assertions for current API-key-first ordering that must flip.",
      "tests/unit/orchestration/agent-runtime/shared/llm/llm-errors-retry.test.ts - Existing proof that a stream with emitted evidence is not replayed.",
      "tests/unit/tui/shared/components/settings-modal.test.ts - Existing Settings editor and persistence interaction pattern.",
      "docs/tmux-uat-guide.md - Installed-binary tmux setup, provider-auth copy, pane capture, and event-search evidence procedure."
    ],
    "patterns": [
      "Use the access-provider definition table as the configured and family-support authority, but use explicit per-family chain arrays instead of the current auth-dependent sort.",
      "Provider policy, static and live, is colocated in `src/infra/llm` so chain order and availability share one home and one import path.",
      "Match `getSharedProviderRateCoordinator()` for process-lifetime, in-memory provider coordination, with explicit test injection for fetch and clock behavior.",
      "Normalize provider quota headers and body extensions at the ChatGPT and Copilot adapter boundaries before publishing narrow internal snapshots.",
      "Keep OAuth values as `Redacted.Redacted`; call `Redacted.value` only while constructing the provider Authorization header or the existing explicit credential serialization DTO.",
      "The chain wrapper intercepts rate-limit errors before `withRetryStream` completes so it can advance to a fresh provider immediately instead of waiting out retry-after on the same provider.",
      "Map the typed terminal quota failure to the existing terminal API failure shape when no later chain entry is available.",
      "Reuse `ProviderStreamEvent.provider_notice` and stable `SessionNotice` ids and scopes for user-visible, model-hidden provider messages.",
      "Persist a concrete provider on every role snapshot so downstream consumers never branch on a missing field; the `automatic` flag distinguishes chain-eligible roles from explicit pins.",
      "Follow the existing schema, text-preserving writer, startup projection, Settings draft, and write-then-reload test pattern for the new nested provider setting.",
      "Use `model.requested.accessProvider` and normalized provider notice telemetry as the inspection surfaces for actual routing and failover causality."
    ],
    "constraints": [
      "User feature description (verbatim, authoritative): ## Step Instructions\n\nDraft an implementation plan from requirements and codebase research.\n\n## User Request\n\nImplement automatic multi-provider selection and failover for LLM access providers. Today `createProviderClient` (src/orchestration/agent-runtime/llm/client-factory.ts:136-166) picks a single provider when the role config omits one, preferring API key over subscription. Replace this with quota-aware provider chains. All design decisions below are settled; do not re-litigate them.\n\n## Core design\n\n1. Provider chain resolution. When a role's `provider` is unset, resolve an ordered chain per model family instead of a single provider: vendor subscription > github_copilot > vendor API key. Concretely: OpenAI family = chatgpt > github_copilot > openai_api; Anthropic family = github_copilot > anthropic_api (there is no Anthropic subscription provider yet; the chain design must trivially accept one later). Chain entries are filtered to providers that are configured (existing `isConfigured` predicates in src/infra/llm/access-provider.ts:16-57) AND support the specific model (Copilot per-model support already exists in src/orchestration/agent-runtime/llm/copilot-model-support.ts) AND pass the new availability predicate (below). The current preference logic at src/infra/llm/access-provider.ts:81-138 is superseded by this chain; rewrite it, do not layer on top. An explicitly configured `provider` on a role pins that provider: no chain, no failover.\n\n2. Failover trigger. Only terminal quota/usage failures advance the chain (the classifier already distinguishes these: `insufficient_quota`, `usage_not_included`, `usage_limit_reached` in src/orchestration/agent-runtime/llm/openai-helpers.ts:51-83 and src/orchestration/agent-runtime/shared/llm/provider-failure.ts). Rate limits, overload, auth, transient network stay in the existing same-provider retry (`withRetryStream`, src/orchestration/agent-runtime/shared/llm/retry.ts) and outer resilience loop (src/orchestration/agent-resilience.ts) exactly as today. Failover replays the request on the next chain entry only when no durable response evidence has been emitted, same invariant withRetryStream already enforces. The natural seam for failover is the client-factory layer where every stream error already crosses `fromStreamError` (client-factory.ts:168-205).\n\n3. Availability predicates, all in-memory, no persisted usage state anywhere. Verified live POC findings (scripts in .flywheel/sessions/b6aef63bd7ef/scratch/: copilot-quota-poc.ts, copilot-streaming-usage-poc.ts, chatgpt-usage-headers-poc.ts):\n\n   Copilot: GET https://api.{domain}/copilot_internal/user with the GitHub token (the `refresh` field of the stored copilot oauth credential; same headers as COPILOT_STATIC_HEADERS) returns `quota_snapshots.premium_interactions` and `quota_reset_date_utc`. On enterprise token-based-billing seats (`unlimited: true, token_based_billing: true`) the meter is `credits_used` (rounded integer, monthly, reset server-side). On non-enterprise plans expect `entitlement`/`remaining` with `unlimited: false` instead; when GitHub enforces its own cap (unlimited=false), treat exhaustion as remaining<=0 from the server and the user cap check does not apply. Availability: credits_used < configured cap. The endpoint is server-cached 60s; the GitHub core rate limit is 15,000/hr so polling is never a rate concern.\n\n   Copilot poll scheduling is spend-triggered, not timer-based: every Copilot response body (verified on streaming /chat/completions, non-streaming and streaming /v1/messages) includes `copilot_usage.total_nano_aiu` (exact request cost; 1 credit = 1e9 nano-AIU). Accumulate nano-AIU since last poll (discard on refresh; this is a scheduler input, never a meter) and re-poll when accumulation crosses a threshold of roughly 10% of remaining headroom, floored at ~5 credits, capped at ~100, with a 60s minimum poll interval. Poll once on first Copilot resolution. Idle sessions must generate zero polls.\n\n   ChatGPT: every ChatGPT backend response carries x-codex headers: `x-codex-primary-used-percent`, `x-codex-primary-reset-at` (epoch seconds), `x-codex-primary-window-minutes`, `x-codex-secondary-*` (secondary window may have window-minutes 0 = inactive), `x-codex-active-limit`, `x-codex-plan-type`. Track these passively from every response (the adapter is src/orchestration/agent-runtime/llm/openai-chatgpt.ts; its custom fetch sees every Response). Availability: last-seen primary used-percent < 100 and (secondary inactive or < 100). Exhausted-until = reset-at. Proactively fail over at 100% without waiting for a usage error. A fresh process during an exhausted window will make one doomed request, learn from the error/headers, and fail over; that is accepted, do not add persistence.\n\n4. Config. New TOML section, e.g. `[providers.github_copilot] monthly_credit_cap = 4000` in the global config schema (src/orchestration/config/schema.ts). Semantics: field absent = uncapped (no availability check against a cap); field present = enforce. The settings UI surface that writes this section pre-fills 4000 as the default value. Wire through src/orchestration/config/loader.ts and writer.ts following existing patterns.\n\n5. User notification. When failover occurs or a provider is skipped as exhausted/over-cap, surface a clear one-time-per-exhaustion-window notice in the session (e.g. \"ChatGPT subscription weekly limit reached, resets <time>; falling back to OpenAI API key\" / \"Copilot at 4000/4000 credits for July; falling back to API key\"). Use the existing event/notification path the runtime uses for provider messages (see src/infra/llm/provider-error-copy.ts for tone). Do not spam per-request.\n\n## Out of scope\n- Anthropic subscription (claude.ai OAuth) login flow. The chain must be extensible to it but do not build it.\n- Any persisted usage store, global or workspace.\n- Changing retry semantics for non-quota failures.\n\n## Acceptance criteria\n- With chatgpt + openai_api both configured and no explicit provider, OpenAI-family requests route to chatgpt first (this flips the current default; verify src/infra/llm/access-provider.ts tests are updated deliberately).\n- A quota-terminal failure on the sub fails over to the next chain entry within the same user turn (when no durable evidence was emitted) and notifies once.\n- Explicit `provider` on a role never fails over.\n- Copilot cap: with monthly_credit_cap set below the live credits_used, Copilot is skipped in the chain; absent cap = never skipped for budget reasons.\n- Unit tests for chain resolution, availability predicates (both Copilot plan shapes, x-codex header parsing including secondary window inactive), poll scheduler thresholds, and failover-vs-pinned behavior. Standard gates: bun run test, bun run lint, bun run check:boundaries.\n- Secrets discipline: GitHub token unwrap only at the fetch header, per existing Redacted conventions.\n- Verify live behavior in the TUI via tmux UAT (docs/tmux-uat-guide.md) at least for the happy path (chatgpt-first routing visible in traces/events).",
      "The settled topology is authoritative. Do not add Anthropic subscription login or quota persistence. Failover applies to the terminal quota classes `insufficient_quota`, `usage_not_included`, and `usage_limit_reached`, and also to `rate_limit_exceeded`, since waiting out retry-after on an already rate-limited provider wastes wall clock when a fresh provider is available.",
      "Provider policy has one home: place the live availability owner beside the static chain policy in `src/infra/llm/provider-availability.ts`, reusing `COPILOT_STATIC_HEADERS` and the credential refresh helper from the Copilot adapter so the poll request is built exactly one way.",
      "Availability filtering applies only to automatic chains. An explicit provider remains a direct pinned request and never advances, even when process-local availability already marks that provider exhausted.",
      "The existing session role snapshot converts omission into a scalar provider. Keep that materialization and add an `automatic: true` flag beside the stored provider, so downstream consumers always see a concrete provider while the flag marks the role as chain-eligible.",
      "Considered: background timers for Copilot quota refresh. Rejected because: Speculative Code and unnecessary lifecycle work. Spend accumulation plus an availability check at the next request boundary gives a 60-second minimum, performs no idle polls, and needs no fire-and-forget task.",
      "Considered: a SQLite quota fact and projection for cross-process continuity. Rejected because: Parallel State and direct conflict with the settled no-persistence requirement. The provider remains the meter authority and Flywheel retains only process-local scheduling and availability snapshots.",
      "The shared availability owner is process-local and singular. Adapter observations, chain resolution, cap policy, and notice-window claims must not keep separate copies of quota state.",
      "The Copilot polling threshold is `min(100, max(5, remainingHeadroom * 0.10))` credits, converted to nano-AIU for exact accumulation. A due poll runs on the next Copilot resolution or request boundary after the 60-second minimum; no timer is created.",
      "Do not disable or replace the existing ChatGPT WebSocket transport. Observe every HTTP Response in the custom fetch, and feed exact terminal quota frames from either transport into the same availability owner.",
      "The three scratch POC files contain request probes but no captured response artifacts. The exact field names and semantics in the authoritative user description are settled test fixtures and must be implemented as specified.",
      "A provider transition within one stream replays the full request on the next chain entry regardless of any partial output already streamed; a duplicated prefix is acceptable because the UI deduplicates rendered output blocks.",
      "Effect Redacted documentation validated through Context7 confirms that Redacted values mask normal logging and that `Redacted.value` explicitly exposes the secret. Keep that call at the Authorization-header boundary. Source: https://github.com/effect-ts/website/blob/main/content/src/content/docs/docs/data-types/redacted.mdx.",
      "Provider skip and failover copy uses stable session notice ids keyed by session, provider, and reset window. Repeated requests in the same window do not create or refresh duplicate user notices.",
      "The full suite, lint, and boundary checks remain final acceptance gates. The installed-binary tmux run is separate behavioral evidence and must query `model.requested` facts for the selected access provider."
    ],
    "project_docs": [
      "docs/adrs/README.md",
      "docs/adrs/adr-002-context-engineering-and-inspectability.md",
      "docs/adrs/adr-005-flywheel-design-principles.md",
      "docs/adrs/adr-007-agent-runtime-process-placements.md",
      "docs/adrs/adr-010-runtime-ui-protocol.md",
      "docs/architecture.md",
      "docs/tmux-uat-guide.md"
    ]
  },
  "phases": [
    {
      "id": "phase-1",
      "goal": "Make automatic provider intent and deterministic family chains explicit from role resolution through runtime selection.",
      "files": [
        "src/infra/llm/access-provider.ts",
        "src/orchestration/agent-runtime/llm/copilot-model-support.ts",
        "src/orchestration/config/model-assignment-providers.ts",
        "src/orchestration/session-role-resolver.ts",
        "src/orchestration/session/schemas.ts",
        "src/orchestration/app-service/history-protocol-types.ts",
        "src/orchestration/app-service/protocol-schemas.ts",
        "src/orchestration/app-service/role-assignment-projection.ts",
        "src/orchestration/app-service/model-assignment-service.ts",
        "tests/unit/orchestration/config/model-listing-access-provider.test.ts",
        "tests/unit/orchestration/session-role-resolver.test.ts",
        "tests/unit/orchestration/session/session-role-assignments.test.ts",
        "tests/unit/orchestration/app-service/model-assignment-service.test.ts",
        "tests/unit/orchestration/model-assignment-controller-scopes.test.ts"
      ],
      "tasks": [
        {
          "id": "t1",
          "description": "First update access-provider tests to state the settled chain order, then replace the current OpenAI priority sort with explicit family chains and expose a non-throwing Copilot model-support predicate that the runtime can use before client construction.",
          "files": [
            "src/infra/llm/access-provider.ts",
            "src/orchestration/agent-runtime/llm/copilot-model-support.ts",
            "src/orchestration/config/model-assignment-providers.ts",
            "tests/unit/orchestration/config/model-listing-access-provider.test.ts"
          ],
          "test_scenarios": [
            "With ChatGPT OAuth, Copilot OAuth, and an OpenAI API key configured, the OpenAI family chain is exactly `chatgpt`, `github_copilot`, `openai_api`.",
            "With Copilot OAuth and an Anthropic API key configured, the Anthropic family chain is exactly `github_copilot`, `anthropic_api`.",
            "The Google family follows the settled general order `github_copilot`, then `google_api` when both are configured.",
            "Unconfigured providers are absent without changing the relative order of configured entries.",
            "A ChatGPT-incompatible model removes ChatGPT, and a Copilot-incompatible model removes Copilot before a client factory is called.",
            "The Copilot assertion and the new non-throwing support predicate accept and reject the same model and family pairs."
          ]
        },
        {
          "id": "t2",
          "description": "First update role snapshot and protocol tests, then materialize the resolved chain head into the stored `provider` scalar and add a new `automatic: true` field beside it, so every downstream consumer keeps receiving a concrete provider while the flag records that the role remains chain-eligible.",
          "files": [
            "src/orchestration/session-role-resolver.ts",
            "src/orchestration/session/schemas.ts",
            "src/orchestration/app-service/history-protocol-types.ts",
            "src/orchestration/app-service/protocol-schemas.ts",
            "src/orchestration/app-service/role-assignment-projection.ts",
            "src/orchestration/app-service/model-assignment-service.ts",
            "tests/unit/orchestration/session-role-resolver.test.ts",
            "tests/unit/orchestration/session/session-role-assignments.test.ts",
            "tests/unit/orchestration/app-service/model-assignment-service.test.ts",
            "tests/unit/orchestration/model-assignment-controller-scopes.test.ts"
          ],
          "test_scenarios": [
            "A resolved role with no configured provider persists the resolved chain-head provider together with `automatic: true`; resolving the snapshot returns that provider and the flag.",
            "A role with an explicit provider persists and restores that exact provider with `automatic: false`.",
            "The runtime history protocol accepts and projects both automatic entries carrying a materialized provider and pinned entries.",
            "A session model save that selects a provider row pins that provider, while reset to an unpinned default restores `automatic: true` with a freshly materialized chain head.",
            "Existing model and effort snapshot behavior remains unchanged."
          ]
        }
      ],
      "verification": "bun run test tests/unit/orchestration/config/model-listing-access-provider.test.ts tests/unit/orchestration/session-role-resolver.test.ts tests/unit/orchestration/session/session-role-assignments.test.ts tests/unit/orchestration/app-service/model-assignment-service.test.ts tests/unit/orchestration/model-assignment-controller-scopes.test.ts",
      "qualitative_verification": null
    },
    {
      "id": "phase-2",
      "goal": "Add the optional Copilot monthly cap to global configuration and expose its distinct uncapped versus UI-prefill semantics.",
      "files": [
        "src/orchestration/config/schema.ts",
        "src/orchestration/config/writer.ts",
        "src/cli/startup-config.ts",
        "src/cli/index.ts",
        "src/tui/app.tsx",
        "src/tui/shell.tsx",
        "src/tui/hooks/create-dialog-modals.tsx",
        "src/tui/hooks/use-settings-modal.ts",
        "src/tui/settings-modal.tsx",
        "tests/unit/orchestration/config/config-settings-persistence.test.ts",
        "tests/unit/cli/startup-config.test.ts",
        "tests/unit/tui/shared/components/settings-modal.test.ts"
      ],
      "tasks": [
        {
          "id": "t1",
          "description": "First add schema and round-trip tests, then add `[providers.github_copilot] monthly_credit_cap` with a schema-level `.default(4000)` so the cap is always enforced, and add a typed nested-section writer that persists the default at startup when the field is missing.",
          "files": [
            "src/orchestration/config/schema.ts",
            "src/orchestration/config/writer.ts",
            "tests/unit/orchestration/config/config-settings-persistence.test.ts"
          ],
          "test_scenarios": [
            "A config without `providers.github_copilot.monthly_credit_cap` decodes with the schema default 4000 applied, and startup persists the defaulted section back to the config file.",
            "`[providers.github_copilot] monthly_credit_cap = 4000` decodes to the number 4000 without an unknown top-level key warning.",
            "Writing a cap creates or updates the nested section once, writes a bare TOML number, preserves role and tracing sections, and reloads to the same value.",
            "A cap of zero is valid and means Copilot is immediately over the configured user cap for enterprise token-based billing seats.",
            "A negative, fractional, or non-numeric cap fails validation and leaves the config file unchanged."
          ]
        },
        {
          "id": "t2",
          "description": "First extend startup and Settings tests, then project the optional loaded cap to the TUI and add a Copilot monthly-credit editor whose draft starts at 4000 only when the stored field is absent.",
          "files": [
            "src/cli/startup-config.ts",
            "src/cli/index.ts",
            "src/tui/app.tsx",
            "src/tui/shell.tsx",
            "src/tui/hooks/create-dialog-modals.tsx",
            "src/tui/hooks/use-settings-modal.ts",
            "src/tui/settings-modal.tsx",
            "tests/unit/cli/startup-config.test.ts",
            "tests/unit/tui/shared/components/settings-modal.test.ts"
          ],
          "test_scenarios": [
            "When the field is absent, the Settings row shows `Uncapped` and opening the editor pre-fills the editable draft with `4000` without treating it as loaded config.",
            "When the field is present, the Settings row and editor show the stored value instead of 4000.",
            "Submitting a valid integer calls the provider-cap writer, updates the row, closes the editor, and shows a success toast.",
            "Invalid text, negative values, and fractional values do not write config and leave the editor open with an actionable error.",
            "A config-load failure keeps the Settings value uncapped while preserving the existing startup config error behavior."
          ]
        }
      ],
      "verification": "bun run test tests/unit/orchestration/config/config-settings-persistence.test.ts tests/unit/cli/startup-config.test.ts tests/unit/tui/shared/components/settings-modal.test.ts",
      "qualitative_verification": null
    },
    {
      "id": "phase-3",
      "goal": "Build one process-local availability substrate and feed it authoritative Copilot spend, Copilot quota snapshots, ChatGPT headers, and terminal quota classification.",
      "files": [
        "src/infra/llm/provider-availability.ts",
        "src/infra/auth/copilot-auth-types.ts",
        "src/orchestration/agent-runtime/llm/copilot.ts",
        "src/orchestration/agent-runtime/llm/openai-chatgpt.ts",
        "src/orchestration/agent-runtime/llm/openai.ts",
        "src/orchestration/agent-runtime/llm/openai-completions.ts",
        "src/orchestration/agent-runtime/llm/anthropic.ts",
        "src/orchestration/agent-runtime/llm/chatgpt-backend-error.ts",
        "src/orchestration/agent-runtime/llm/openai-helpers.ts",
        "src/orchestration/agent-runtime/shared/llm/errors.ts",
        "src/orchestration/agent-runtime/shared/llm/provider-failure.ts",
        "tests/unit/orchestration/agent-runtime/llm/provider-availability.test.ts",
        "tests/unit/orchestration/agent-runtime/llm/copilot-usage-observation.test.ts",
        "tests/unit/orchestration/agent-runtime/llm/openai-chatgpt-adapter.test.ts",
        "tests/unit/orchestration/agent-runtime/llm/openai-error-classification.test.ts",
        "tests/unit/orchestration/agent-runtime/shared/llm/provider-failure.test.ts",
        "tests/unit/orchestration/agent-runtime/shared/llm/llm-errors-retry.test.ts"
      ],
      "tasks": [
        {
          "id": "t1",
          "description": "First add parser, predicate, and scheduler tests, then implement one process-lifetime in-memory availability owner for Copilot and ChatGPT with injected fetch and clock seams for deterministic tests.",
          "files": [
            "src/infra/llm/provider-availability.ts",
            "tests/unit/orchestration/agent-runtime/llm/provider-availability.test.ts"
          ],
          "test_scenarios": [
            "An enterprise Copilot snapshot with `unlimited: true`, `token_based_billing: true`, and `credits_used: 4000` is unavailable at cap 4000, available at cap 4001, and available for budget reasons when the cap is absent.",
            "A non-enterprise Copilot snapshot with `unlimited: false` is unavailable when `remaining <= 0`, available when `remaining > 0`, and ignores the user cap because the server entitlement is authoritative.",
            "Copilot reset data and the current calendar month produce a stable exhaustion-window key and notice detail.",
            "ChatGPT is unavailable when primary used-percent is at least 100, or when an active secondary window is at least 100.",
            "A ChatGPT secondary window with `window-minutes = 0` is inactive and does not make the provider unavailable even if its used-percent is 100.",
            "ChatGPT reset epochs produce the exhausted-until value for the exhausted active window; values below 100 remain available.",
            "The first Copilot availability resolution polls exactly once; later idle time produces zero polls.",
            "The spend threshold is `max(5, 10% of remaining headroom)` capped at 100 credits, expressed exactly in nano-AIU, and a poll clears the accumulated scheduler input.",
            "Crossing the spend threshold before the 60-second minimum does not poll; the next provider-resolution check after 60 seconds polls without a timer.",
            "Malformed external response fields do not become trusted internal availability data and produce a clear boundary error or an unknown snapshot, according to the owning fetch contract."
          ]
        },
        {
          "id": "t2",
          "description": "First add quota-fetch boundary tests, then poll `https://api.{domain}/copilot_internal/user` with the stored GitHub token and Copilot static headers, parsing only the settled quota snapshot fields and never persisting the result.",
          "files": [
            "src/infra/llm/provider-availability.ts",
            "src/infra/auth/copilot-auth-types.ts",
            "tests/unit/orchestration/agent-runtime/llm/provider-availability.test.ts"
          ],
          "test_scenarios": [
            "The individual GitHub domain polls `https://api.github.com/copilot_internal/user`; an enterprise domain uses its matching `api.{domain}` host.",
            "The request uses `Accept`, `COPILOT_STATIC_HEADERS`, and one Authorization header built from the Redacted GitHub token.",
            "The quota poll logs the full outgoing request, including the Authorization header value, at debug level so quota problems can be diagnosed from the global log file.",
            "A failed or malformed quota poll does not invent an exhausted or available meter and does not erase the last valid in-memory snapshot."
          ]
        },
        {
          "id": "t3",
          "description": "First add adapter-observation tests, then pass the shared availability observer through the existing ChatGPT custom fetch and all three Copilot protocol adapters so provider data is normalized once at its external boundary.",
          "files": [
            "src/orchestration/agent-runtime/llm/copilot.ts",
            "src/orchestration/agent-runtime/llm/openai-chatgpt.ts",
            "src/orchestration/agent-runtime/llm/openai.ts",
            "src/orchestration/agent-runtime/llm/openai-completions.ts",
            "src/orchestration/agent-runtime/llm/anthropic.ts",
            "tests/unit/orchestration/agent-runtime/llm/copilot-usage-observation.test.ts",
            "tests/unit/orchestration/agent-runtime/llm/openai-chatgpt-adapter.test.ts"
          ],
          "test_scenarios": [
            "The ChatGPT fetch observer parses all primary, secondary, active-limit, plan-type, reset-at, and window-minutes headers on successful and failed HTTP Responses before any friendly error replacement.",
            "Header names are case-insensitive, secondary window zero remains inactive, and missing headers leave the prior snapshot unchanged.",
            "A terminal ChatGPT quota error from either SSE or WebSocket updates the same in-memory exhausted state even when no HTTP header snapshot is available.",
            "Streaming Copilot Chat Completions observes `copilot_usage.total_nano_aiu` once for the completed request.",
            "Streaming Copilot OpenAI Responses observes `copilot_usage.total_nano_aiu` once for the completed request.",
            "Streaming and non-streaming Copilot Anthropic Messages observe `copilot_usage.total_nano_aiu` once for the completed request.",
            "Repeated chunks that carry the same request total do not double-count nano-AIU."
          ]
        },
        {
          "id": "t4",
          "description": "First extend classification and retry tests for all settled terminal quota codes, then add a typed quota failure through OpenAI and shared provider boundaries without changing rate-limit, overload, auth, network, or abort policy.",
          "files": [
            "src/orchestration/agent-runtime/llm/chatgpt-backend-error.ts",
            "src/orchestration/agent-runtime/llm/openai-helpers.ts",
            "src/orchestration/agent-runtime/shared/llm/errors.ts",
            "src/orchestration/agent-runtime/shared/llm/provider-failure.ts",
            "tests/unit/orchestration/agent-runtime/llm/openai-error-classification.test.ts",
            "tests/unit/orchestration/agent-runtime/shared/llm/provider-failure.test.ts",
            "tests/unit/orchestration/agent-runtime/shared/llm/llm-errors-retry.test.ts"
          ],
          "test_scenarios": [
            "`insufficient_quota`, `usage_not_included`, and `usage_limit_reached` become the typed terminal quota failure and receive no same-provider retry delay.",
            "ChatGPT friendly error normalization preserves the original quota code, plan type, and reset time needed by classification and notices.",
            "`rate_limit_exceeded` becomes a chain-advancing failure so a rate-limited provider is left behind immediately instead of waiting out retry-after.",
            "Server overload remains terminal for the inner stream retry and recoverable by the existing outer resilience behavior.",
            "Authentication, transient network, context overflow, output overflow, malformed request, and abort classifications remain unchanged."
          ]
        }
      ],
      "verification": "bun run test tests/unit/orchestration/agent-runtime/llm/provider-availability.test.ts tests/unit/orchestration/agent-runtime/llm/copilot-usage-observation.test.ts tests/unit/orchestration/agent-runtime/llm/openai-chatgpt-adapter.test.ts tests/unit/orchestration/agent-runtime/llm/openai-error-classification.test.ts tests/unit/orchestration/agent-runtime/shared/llm/provider-failure.test.ts tests/unit/orchestration/agent-runtime/shared/llm/llm-errors-retry.test.ts",
      "qualitative_verification": null
    },
    {
      "id": "phase-4",
      "goal": "Resolve lazy automatic chains at the client-factory boundary, fail over safely inside one streamed turn, and surface accurate one-time session notices and audit data.",
      "files": [
        "src/orchestration/agent-runtime/llm/provider-chain-client.ts",
        "src/orchestration/agent-runtime/llm/client-factory.ts",
        "src/orchestration/agent-runtime/errors.ts",
        "src/orchestration/agent-runtime/factory.ts",
        "src/orchestration/workflow-deps.ts",
        "src/orchestration/agent-runtime/shared/runtime-assembly.ts",
        "src/orchestration/agent-runtime/shared/provider-request-audit.ts",
        "tests/unit/orchestration/agent-runtime/llm/provider-chain-client.test.ts",
        "tests/unit/orchestration/agent-runtime/llm/client-factory.test.ts",
        "tests/unit/orchestration/agent-runtime/shared/llm/llm-client-routing.test.ts",
        "tests/unit/orchestration/agent-runtime/shared/llm/llm-client-retry.test.ts",
        "tests/unit/orchestration/workflow-deps.test.ts",
        "tests/unit/orchestration/session/provider-request-audit-store.test.ts"
      ],
      "tasks": [
        {
          "id": "t1",
          "description": "First add focused chain-client tests with fake provider clients, then implement a lazy delegating LLM client that checks availability before each stream, preserves one active delegate, and advances to the next provider whenever the active provider reports a terminal quota failure or a rate limit, replaying the full StreamOptions on the next entry.",
          "files": [
            "src/orchestration/agent-runtime/llm/provider-chain-client.ts",
            "src/orchestration/agent-runtime/errors.ts",
            "tests/unit/orchestration/agent-runtime/llm/provider-chain-client.test.ts",
            "tests/unit/orchestration/agent-runtime/shared/llm/llm-client-retry.test.ts"
          ],
          "test_scenarios": [
            "An automatic OpenAI request starts on ChatGPT and replays the same StreamOptions on Copilot after a terminal quota failure.",
            "If ChatGPT is already exhausted from headers, it is skipped before the request and the next available chain entry runs.",
            "If Copilot is over its configured cap after the first quota poll, it is skipped before client construction and the next available chain entry runs.",
            "A terminal quota failure mid-stream replays the full request on the next chain entry; the duplicated prefix is dropped by the UI renderer.",
            "A rate limit advances the chain to the next available provider without consuming the same-provider retry budget.",
            "Overload, auth, transient network, malformed request, overflow, and abort never advance the chain.",
            "After failover, later streams start on the new active provider unless its availability predicate now excludes it.",
            "If no later provider is available, the typed quota failure leaves the client boundary and maps to the existing terminal API failure shape rather than entering outer overload resilience."
          ]
        },
        {
          "id": "t2",
          "description": "First extend client-factory, routing, and workflow-dependency tests, then integrate configured, model-supported, availability-approved candidates into automatic client creation while keeping explicit provider creation on the current single-provider path.",
          "files": [
            "src/orchestration/agent-runtime/llm/client-factory.ts",
            "src/orchestration/agent-runtime/factory.ts",
            "src/orchestration/workflow-deps.ts",
            "tests/unit/orchestration/agent-runtime/llm/client-factory.test.ts",
            "tests/unit/orchestration/agent-runtime/shared/llm/llm-client-routing.test.ts",
            "tests/unit/orchestration/workflow-deps.test.ts"
          ],
          "test_scenarios": [
            "An omitted provider creates the ordered automatic chain and starts with ChatGPT when ChatGPT and OpenAI API access are both configured.",
            "An explicit `chatgpt`, `github_copilot`, `openai_api`, or `anthropic_api` creates only that provider client, bypasses automatic availability filtering, and never enables failover.",
            "Unknown, unsupported-family, and unconfigured explicit providers keep their existing actionable typed errors.",
            "Copilot model support is checked before any quota poll or Copilot client construction.",
            "The loaded optional monthly cap reaches the shared process-local availability owner through runtime composition; no quota value enters session facts or runner options.",
            "Auth refresh still affects later client creation without creating a second availability store."
          ]
        },
        {
          "id": "t3",
          "description": "First add notice and audit assertions, then emit stable provider notices for skips and failovers, deduplicate them by session, provider, and exhaustion-window key, and make request audit read the active provider when each request starts.",
          "files": [
            "src/orchestration/agent-runtime/llm/provider-chain-client.ts",
            "src/orchestration/agent-runtime/shared/runtime-assembly.ts",
            "src/orchestration/agent-runtime/shared/provider-request-audit.ts",
            "tests/unit/orchestration/agent-runtime/llm/provider-chain-client.test.ts",
            "tests/unit/orchestration/session/provider-request-audit-store.test.ts"
          ],
          "test_scenarios": [
            "A ChatGPT primary or weekly-window exhaustion notice names the reset time and the selected fallback provider.",
            "A Copilot cap notice names current credits, configured cap, calendar month, and the selected fallback provider.",
            "Repeated requests in the same session and exhaustion window do not emit another upsert; a new reset window can emit one new notice.",
            "The existing `provider_notice` route makes the notice visible in the session notice projection without adding it to model-visible conversation context.",
            "A provider skipped before the first request produces the same one-time notice behavior as a provider that fails during streaming.",
            "`model.requested.accessProvider` records the initially selected provider, and requests after a failover record the new active provider; the in-stream failover notice remains visible in stream telemetry for causal inspection.",
            "Notice copy contains no OAuth token, authorization header, raw quota response, or other credential data."
          ]
        }
      ],
      "verification": "bun run test tests/unit/orchestration/agent-runtime/llm/provider-chain-client.test.ts tests/unit/orchestration/agent-runtime/llm/client-factory.test.ts tests/unit/orchestration/agent-runtime/shared/llm/llm-client-routing.test.ts tests/unit/orchestration/agent-runtime/shared/llm/llm-client-retry.test.ts tests/unit/orchestration/workflow-deps.test.ts tests/unit/orchestration/session/provider-request-audit-store.test.ts",
      "qualitative_verification": null
    },
    {
      "id": "phase-5",
      "goal": "Document the resulting authority, run repository-wide gates, and verify ChatGPT-first routing through the installed TUI.",
      "files": [
        "docs/architecture.md",
        "docs/tmux-uat-guide.md"
      ],
      "tasks": [
        {
          "id": "t1",
          "description": "Update current architecture and UAT documentation in present tense so access resolution, process-local quota ownership, automatic versus pinned roles, failover evidence gating, event inspection, and the Copilot cap are discoverable without adding a change log.",
          "files": [
            "docs/architecture.md",
            "docs/tmux-uat-guide.md"
          ],
          "test_scenarios": [
            "The architecture document identifies static family-chain policy, process-local availability state, and client-factory failover as one-direction orchestration without claiming quota persistence.",
            "The UAT guide gives a provider-routing scenario that checks the actual `model.requested.accessProvider` fact rather than inferring routing from model output.",
            "Documentation states that explicit role providers do not fail over and that non-quota retry semantics are unchanged."
          ]
        },
        {
          "id": "t2",
          "description": "Run the full unit, lint, and boundary gates after all phases, install the packaged binary, and drive an isolated tmux chat with an unpinned OpenAI-family role while both ChatGPT and OpenAI API access are configured.",
          "files": [
            "docs/tmux-uat-guide.md"
          ],
          "test_scenarios": [
            "`bun run test`, `bun run lint`, and `bun run check:boundaries` all exit successfully.",
            "`bun run install:local` installs the current packaged binary before UAT.",
            "The isolated UAT HOME copies auth and global config, removes any explicit provider from the tested role, and keeps both ChatGPT and OpenAI API access configured.",
            "A simple chat completes in the installed TUI and the session `model.requested` event shows `accessProvider: chatgpt`.",
            "The pane and stderr capture show no unexpected provider warning, auth leak, or startup failure on the happy path."
          ]
        }
      ],
      "verification": "bun run test && bun run lint && bun run check:boundaries && bun run install:local",
      "qualitative_verification": "Use the installed `flywheel` binary in an isolated tmux HOME as specified in `docs/tmux-uat-guide.md`. Send one bounded prompt through an unpinned OpenAI-family role, capture the pane and stderr, locate the session id, and run `flywheel events:search --base-dir <uat-dir> --session <session-id> --type model.requested --latest --json`. Confirm that the response completed and the event payload names `chatgpt` as the access provider while OpenAI API access was also configured."
    }
  ],
  "success_criteria": [
    "With ChatGPT, Copilot, and OpenAI API access configured and no role provider, an OpenAI-family request selects `chatgpt`, then `github_copilot`, then `openai_api` after filtering configuration, model support, and live availability.",
    "With Copilot and Anthropic API access configured and no role provider, an Anthropic-family request selects `github_copilot`, then `anthropic_api`; the chain table can accept a future Anthropic subscription entry without a new selection algorithm.",
    "An explicit role provider creates one provider client, bypasses automatic availability skips, and never performs cross-provider failover.",
    "`insufficient_quota`, `usage_not_included`, `usage_limit_reached`, and `rate_limit_exceeded` advance an automatic chain, replaying the full request on the next entry.",
    "Overload, authentication, transient network errors, malformed requests, overflows, and aborts keep their existing same-provider retry or outer resilience behavior.",
    "A Copilot enterprise token-billing snapshot enforces `credits_used < monthly_credit_cap`, with the schema default of 4000 applied when the field is absent.",
    "A non-enterprise Copilot snapshot uses server `remaining <= 0` as exhaustion and ignores the user cap.",
    "Copilot polls once on first resolution, repolls only after spend crosses the clamped threshold and the 60-second minimum, clears scheduler accumulation after a poll, and performs no idle timer polls.",
    "ChatGPT success and error Responses update primary and secondary window state; a secondary window with zero minutes is inactive, and any active window at 100 percent proactively excludes ChatGPT.",
    "A fresh process can make one exhausted ChatGPT request, then marks the window unavailable and fails over without persisted usage state.",
    "Each skip or failover emits one clear session notice per provider exhaustion window, names the reset or cap context and selected fallback, and stays outside model-visible conversation context.",
    "Provider request audit records the provider selected at each request boundary, including the new active provider on requests after failover; normalized notice telemetry makes the transition inspectable.",
    "The global TOML loader and writer round-trip `[providers.github_copilot] monthly_credit_cap`, applying and persisting the default 4000 when the field is absent.",
    "The GitHub token remains Redacted in memory and is unwrapped only when the Copilot quota fetch Authorization header is constructed; quota-poll debug logging captures the full request for diagnosis.",
    "`bun run test`, `bun run lint`, and `bun run check:boundaries` all pass.",
    "Installed-binary tmux UAT completes an unpinned OpenAI-family happy-path turn with both ChatGPT and OpenAI API access configured, and a `model.requested` event identifies `chatgpt`.",
    "No instance of a persisted quota or usage store, fact, projection, cache file, or session field in `src/`; provider meters and polling scheduler inputs remain process-local only."
  ],
  "open_questions": [],
  "implementation_contract": {
    "directives": [
      {
        "id": "d1",
        "text": "Unpinned roles resolve the settled ordered family chain and persist the materialized chain head with `automatic: true`, while a present role provider remains a single pinned provider with no failover.",
        "completion_check": "`tests/unit/orchestration/config/model-listing-access-provider.test.ts`, `tests/unit/orchestration/session-role-resolver.test.ts`, and `tests/unit/orchestration/agent-runtime/llm/client-factory.test.ts` assert chain order, materialized automatic snapshots, and pinned behavior."
      },
      {
        "id": "d2",
        "text": "Cross-provider stream replay occurs for the three terminal quota codes and for rate limits, replaying the full request on the next chain entry; every other failure keeps existing retry and resilience policy.",
        "completion_check": "`tests/unit/orchestration/agent-runtime/llm/provider-chain-client.test.ts`, `tests/unit/orchestration/agent-runtime/llm/openai-error-classification.test.ts`, and `tests/unit/orchestration/agent-runtime/shared/llm/llm-errors-retry.test.ts` cover quota, rate-limit, and non-quota branches."
      },
      {
        "id": "d3",
        "text": "Copilot and ChatGPT availability use one process-local owner with no persistence, including Copilot first-use polling, spend thresholds, both Copilot plan shapes, and ChatGPT primary and secondary windows.",
        "completion_check": "`tests/unit/orchestration/agent-runtime/llm/provider-availability.test.ts` covers predicates, headers, scheduler thresholds, 60-second gating, first-use polling, and zero idle polls; a source search finds no quota field in session fact or projection schemas."
      },
      {
        "id": "d4",
        "text": "Provider skips and failovers use the existing session notice path and emit at most one notice per session, provider, and exhaustion window.",
        "completion_check": "`tests/unit/orchestration/agent-runtime/llm/provider-chain-client.test.ts` asserts stable notice identity and per-window deduplication, and `tests/unit/orchestration/session/provider-request-audit-store.test.ts` asserts inspectable provider transition evidence."
      }
    ]
  }
}