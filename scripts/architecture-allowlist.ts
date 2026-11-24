import type { KnownFinding } from "./architecture/known-findings.ts";

// The reviewed findings of `bun run check:architecture` (ARCH-STRUCTURE-045).
// Each entry names one finding by its rule and key and says why it stays:
// a part of the design that the rule cannot tell from a defect, or known
// debt with its cheapest fix. A key holds no line number: it is the sorted
// members of a circle, the owner and name of a field, or the path of a
// module, directory, or file. A finding matches an entry only by its exact
// key, so a circle that grows, splits, or changes members is a new finding.
//
// The check fails on a finding that no entry names, and on an entry that no
// finding matches. When a fix removes a finding, remove its entry. Add an
// entry only for a finding that review accepts, never to silence a new
// problem.

export const KNOWN_ARCHITECTURE_FINDINGS: readonly KnownFinding[] = [
  // By design: a published contract, a registration seam, or peers that
  // grow by design.
  { lint: "shallow-module", key: "flywheel::infra::code-mode::stdlib", reason: "Interpreter built-ins: each export is one standard-library value that the interpreter installs; the width mirrors the language library." },
  { lint: "shallow-module", key: "flywheel::protocol", reason: "Published client contract: the wire schemas and shared client core that every client host imports by design (AGENTS.md section 7, ARCH-PROTOCOL-003); its width is the contract, not a leak of internals." },
  { lint: "shallow-module", key: "flywheel::protocol::modules", reason: "Published per-module protocol contracts (cursor domains, codecs, queries, mutations) that clients import by design; the same contract as src/protocol." },
  { lint: "shallow-module", key: "flywheel::protocol::modules::remote", reason: "Published per-module protocol contracts (cursor domains, codecs, queries, mutations) that clients import by design; the same contract as src/protocol." },
  { lint: "shallow-module", key: "flywheel::tui::commands", reason: "Command registration seam: commands register at the TUI dispatch boundary (AGENTS.md section 7, add behavior by registration); the registration types are its interface." },
  { lint: "wide-directory", key: "src/infra/tools/displays/", reason: "One display per tool, registered by tool id; peers by design." },
  { lint: "wide-directory", key: "src/orchestration/modules/", reason: "One home per first-party module by design (AGENTS.md section 7, docs/architecture.md 'Where New Code Lives'); the entries are peers, not a missing subdivision." },
  { lint: "wide-directory", key: "src/orchestration/modules/workflows/migrations/", reason: "One file per dated migration; the set grows by design and has no subdivision by concern." },
  { lint: "long-file", key: "src/infra/code-mode/interpreter/runtime.ts", reason: "Exact upstream donor file kept intact for future upstream diffs; scripts/check-file-sizes.ts exempts it the same way (VENDORED_FILE_SIZE_EXEMPTIONS)." },
  {
    lint: "module-cycle",
    reason: "Vendored upstream interpreter (src/infra/code-mode/VENDOR.md): its module layout stays identical to upstream so future upstream diffs apply; the same reason exempts runtime.ts from long-file.",
    key: [
      "flywheel::infra::code-mode::codemode",
      "flywheel::infra::code-mode::interpreter",
      "flywheel::infra::code-mode::stdlib",
      "flywheel::infra::code-mode::tool-runtime",
    ].join(","),
  },
  {
    lint: "module-cycle",
    reason: "vm uses run's root selectors (run/workflow-root) and projection boundary (run/session-fact-source), composes the run-facts codecs, and folds the facts that context-bundle writes, while run/workflow-root, run/session-fact-source, and context-bundle decode facts through vm's parseWorkflowSessionFact and workflowAggregateId, and view reads vm's recovery; run/workflow-completion also reads the view and the context of a finished run; src/orchestration imports both from vm, so moving them below vm also changes those imports. Give workflowAggregateId a home below vm, give each lower module a parser of its own fact family, and pass the historical-tree function into queueFromProjection, then reassess.",
    key: [
      "flywheel::workflows::context-bundle",
      "flywheel::workflows::run",
      "flywheel::workflows::view",
      "flywheel::workflows::vm",
    ].join(","),
  },
  { lint: "shallow-module", key: "flywheel::orchestration::runner", reason: "AgentGeneration now gives one-shot callers a contract without the chat turn slot of AgentHost, but OutputSession and Runner still show most of their methods. Next cut: move OutputSession to session-store, which drives it (ARCH-SESSIONS-002)." },
  { lint: "shallow-module", key: "flywheel::orchestration::session-store", reason: "SessionStoreReader now gives read-only projections a contract without runner control, but SessionStore still shows 31 methods. Next cut: move toSessionView and createSessionViewLoader (view.ts) to the app-service projections that use them, and give app-service one runner-control interface that keeps the activeEntry rule in the store." },
  { lint: "shallow-module", key: "flywheel::protocol::client", reason: "The workflow message-target lines and refusal left the shared client core for workflow-host/workflow-addressing.ts, and the compaction notice and the message type label left for their one orchestration user; the named-target resolver and the round target stay, because the client core owns the address model (ARCH-PROTOCOL-052). It still shows 368 of 674 functions and hides 306. Moving functions out clears it only after about 63 shown functions leave, and only 36 shown functions have one outside consumer and no use inside the core (21 webview, 7 TUI, 6 orchestration, 1 cli, 1 editor), so relocation cannot clear it; 237 are called by both the TUI and the webview, which is the core's purpose. Hiding shown functions in place clears it after about 32. Next cut: move the work that both clients repeat on top of these helpers into the core, so each client calls one function per job and the helpers become hidden (start with the widest interfaces: SessionChangesController 18, RuntimeConnection 15, HeldSessionDetails 14, TranscriptStore 14, ChatSubmissions 13)." },
  { lint: "shallow-module", key: "flywheel::tui::transcript::transcript-store", reason: "OutputTranscriptCache is split into residency, paging, and reads, and the module binds the per-session view itself; it stays shallow because createOutputTranscriptCache works on 14 of the module's own types in one 650-line closure and OutputWindow uses all 14 functions of OutputTranscriptView. Next cut: move the frame-batched Solid projection (snapshot, freshness, count, streaming-text, and disclosure stores) out of the factory closure into its own part, then give the scroll controller one viewport-paging interface." },
  { lint: "wide-directory", key: "src/infra/", reason: "Its 233 loose files cannot all go into directories without new shallow-module findings. About 45 of them are small helpers and contracts that every layer uses and that hide almost nothing (error-message, redact-secrets, record, invariant, abort, assert-never, with-deadline, operation-log, ordered-lane, paths, model-id, skill-id, workflow-yaml, module-runtime, module-service, and the like). A full grouping by concern (primitives, platform, diagnostics, process, supervision, distribution, substrate, session, definitions, transcript) has no module cycle, but gives 12 new shallow modules, for example primitives (shows 77 of 131 functions), platform/paths (65 of 77), definitions (40 of 58), and substrate/store (97 of 186). The layers keep these helpers out of the deep groups: debug-log needs paths and private-path, the contained directory needs error-message, and owned-command-supervisor needs update/. Next cut, which adds no finding: move 72 files into process/ (kernel, container, holders, channels, workers), supervision/ (launch, guardian, persistent, commands), distribution/ (update/, source-snapshot, launch-state, foreground-successor, antigravity-engine-pin), and diagnostics/ (log, debug-log, diagnostics-registry, repeat-coalescer, event-loop-lag, startup timeline and trace), which leaves 173 members. Then decide a home for the shared helpers." },
  { lint: "wide-directory", key: "src/orchestration/", reason: "Its 16 subdirectories are module homes or kernel areas, and AGENTS.md section 7 keeps the registry files modules.ts and credential-provider-modules.ts at the top, so it cannot hold fewer than 18 members. Next cut: move the loose kernel catalog files (definition-catalog, definition-health, module-requirements, tool-catalog, workspace-state, custom-provider-modules, and the rest) into one or two kernel subdirectories, but only when the orchestration module cycle is reworked, because their module keys are members of that cycle." },
  { lint: "wide-directory", key: "src/protocol/", reason: "One measured trial grouped the 78 files by concern into nine directories (rpc, runtime, auth, models, session, transcript, settings, git, update). It added six shallow-module findings (runtime shows 36 of 48 functions, rpc 23 of 32, session 18 of 18, models 14 of 16, settings 14 of 18, transcript 12 of 19), because most of these files show their functions to code outside src/protocol by design (the flywheel::protocol entry). Moving the five runtime-* files into rpc/ also changes the key of the client/modules circle entry, which gives a new circle finding and a stale entry and needs its own allowlist decision. Next cut: first break the client/modules dependency through the shared host contract (the next cut of that circle entry), then try the grouping again." },
  { lint: "wide-directory", key: "src/protocol/client/", reason: "Most of its 92 files are small helpers that the TUI and the webview call directly, so a concern group of them shows almost every function it holds. Of the nine concern groups (transcript, workflow, runtime, reads, session, chat, providers, host, settings), only transcript (55 shown, 81 hidden), workflow (49, 66), runtime (30, 41), and host pass; reads shows 89 of 150 functions, session 62 of 81, chat 49 of 63, providers 21 of 22, and settings 14 of 18, and depending on where background-index goes, reads, session, chat, transcript, and workflow use each other in a circle. A greedy trial that leaves loose at the top the files that make a group shallow left 23 loose files for that layout (5 of reads, 4 of session, 9 of chat, 3 of providers, 2 of settings), 36 members in all, and 16 loose files for a layout that merges reads with session, chat with transcript, and providers with settings, which still has a circle of transcript, session, and workflow; these are trial results, not proven minimums. Moving transcript/, workflow/, runtime/, and host/ alone (39 files) adds no finding and leaves 57 members, but rewrites the imports of about 290 files in every client. Next cut: the cut of the flywheel::protocol::client entry (move the work that both clients repeat into the core, so each client calls fewer helpers), then make those four directories and group the rest again." },
  {
    lint: "module-cycle",
    reason: "`module-requirements` (module-requirements.ts:31) and `tool-catalog` read the tool declaration types of agent-runtime/tools/dispatch/tool-registry.ts while `agent-runtime` calls them; give the tool declaration contract a home below all three, then reassess. `module-catalog` joins because it reads the `DefinitionContribution` union of modules.ts (module-catalog.ts:143) while modules.ts calls installedModules; give the module descriptor and contribution types a home below both.",
    key: [
      "flywheel::orchestration::agent-runtime",
      "flywheel::orchestration::app-service",
      "flywheel::orchestration::auth",
      "flywheel::orchestration::chat",
      "flywheel::orchestration::config",
      "flywheel::orchestration::credential-provider-modules",
      "flywheel::orchestration::custom-provider-modules",
      "flywheel::orchestration::definition-catalog",
      "flywheel::orchestration::definition-health",
      "flywheel::orchestration::file-edits",
      "flywheel::orchestration::headless",
      "flywheel::orchestration::migrations",
      "flywheel::orchestration::module-catalog",
      "flywheel::orchestration::module-requirements",
      "flywheel::orchestration::modules",
      "flywheel::orchestration::runner",
      "flywheel::orchestration::session",
      "flywheel::orchestration::session-store",
      "flywheel::orchestration::subscription-spend-consent",
      "flywheel::orchestration::tool-catalog",
      "flywheel::orchestration::update",
      "flywheel::orchestration::workflow-host",
      "flywheel::orchestration::workspace-state",
    ].join(","),
  },
];
