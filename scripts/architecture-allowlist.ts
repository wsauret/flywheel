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

const WIDE = "Group its entries by concern into subdirectories.";

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
    reason: "vm folds the facts that workflow-root, session-fact-source, and context-bundle write, while they decode facts through vm's parseWorkflowSessionFact and workflowAggregateId, and view reads vm's recovery; src/orchestration imports both from vm, so moving them below vm also changes those imports. Give workflowAggregateId a home below vm, give each lower module a parser of its own fact family, and pass the historical-tree function into queueFromProjection, then reassess.",
    key: [
      "flywheel::workflows::context-bundle",
      "flywheel::workflows::session-fact-source",
      "flywheel::workflows::view",
      "flywheel::workflows::vm",
      "flywheel::workflows::workflow-root",
    ].join(","),
  },
  {
    lint: "module-cycle",
    reason: "The command context reads the shell (ShellSignals fields, RuntimeConfigCache.view, mutateRuntimeConfig, and the report-async reporters), while the shell wires the commands. The cheapest tie: `hooks` uses `commands` by 3 items (commandsToOptions, CommandDispatch.dispatch, SurfaceRequest.isCurrent), against 7 the other way, but those 3 are the commands' own interface, so cut the 7 instead: give the command context its own contract in commands/command-types.ts that the shell state and the runtime config cache satisfy, and move report-async below both.",
    key: [
      "flywheel::tui::commands",
      "flywheel::tui::hooks",
    ].join(","),
  },
  { lint: "shallow-module", key: "flywheel::orchestration::runner", reason: "AgentGeneration now gives one-shot callers a contract without the chat turn slot of AgentHost, but OutputSession and Runner still show most of their methods. Next cut: move OutputSession to session-store, which drives it (ARCH-SESSIONS-002)." },
  { lint: "shallow-module", key: "flywheel::orchestration::session-store", reason: "SessionStoreReader now gives read-only projections a contract without runner control, but SessionStore still shows 31 methods. Next cut: move toSessionView and createSessionViewLoader (view.ts) to the app-service projections that use them, and give app-service one runner-control interface that keeps the activeEntry rule in the store." },
  { lint: "shallow-module", key: "flywheel::protocol::client", reason: "The shared client core shows about 357 of 555 functions, most of them small helpers that both the terminal and the web client call. Next cut: move the functions that only orchestration calls (workflow address and target parsing, RuntimeConnection ready and fault, decodeRuntimeEventFrame, workflow progress and coverage text) to the orchestration domain that uses them." },
  { lint: "shallow-module", key: "flywheel::tui::transcript-store", reason: "OutputTranscriptCache is split into residency, paging, and reads, and the module binds the per-session view itself; it stays shallow because createOutputTranscriptCache works on 14 of the module's own types in one 650-line closure and OutputWindow uses all 14 functions of OutputTranscriptView. Next cut: move the frame-batched Solid projection (snapshot, freshness, count, streaming-text, and disclosure stores) out of the factory closure into its own part, then give the scroll controller one viewport-paging interface." },
  { lint: "wide-directory", key: "src/infra/", reason: WIDE },
  { lint: "wide-directory", key: "src/infra/llm/", reason: WIDE },
  { lint: "wide-directory", key: "src/orchestration/", reason: "Its 16 subdirectories are module homes or kernel areas, and AGENTS.md section 7 keeps the registry files modules.ts and credential-provider-modules.ts at the top, so it cannot hold fewer than 18 members. Next cut: move the loose kernel catalog files (definition-catalog, definition-health, module-requirements, tool-catalog, workspace-state, custom-provider-modules, and the rest) into one or two kernel subdirectories, but only when the orchestration module cycle is reworked, because their module keys are members of that cycle." },
  { lint: "wide-directory", key: "src/orchestration/agent-runtime/", reason: WIDE },
  { lint: "wide-directory", key: "src/orchestration/agent-runtime/llm/", reason: WIDE },
  { lint: "wide-directory", key: "src/orchestration/agent-runtime/tools/", reason: WIDE },
  { lint: "wide-directory", key: "src/orchestration/app-service/", reason: WIDE },
  { lint: "wide-directory", key: "src/orchestration/modules/development/benchmark/", reason: WIDE },
  { lint: "wide-directory", key: "src/orchestration/modules/provider-claude-agent-sdk/", reason: WIDE },
  { lint: "wide-directory", key: "src/orchestration/session/", reason: WIDE },
  { lint: "wide-directory", key: "src/protocol/", reason: WIDE },
  { lint: "wide-directory", key: "src/protocol/client/", reason: WIDE },
  { lint: "wide-directory", key: "src/tui/", reason: WIDE },
  { lint: "wide-directory", key: "src/tui/components/", reason: WIDE },
  { lint: "wide-directory", key: "src/tui/hooks/", reason: WIDE },
  { lint: "wide-directory", key: "src/workflows/", reason: WIDE },
  { lint: "wide-directory", key: "src/workflows/vm/", reason: WIDE },
  { lint: "wide-directory", key: "webview/src/app/", reason: WIDE },
  { lint: "wide-directory", key: "webview/src/client/", reason: WIDE },
  {
    lint: "module-cycle",
    reason: "`module-requirements` (module-requirements.ts:31) and `tool-catalog` read the tool declaration types of agent-runtime/tools/tool-registry.ts while `agent-runtime` calls them; give the tool declaration contract a home below all three, then reassess. `module-catalog` joins because it reads the `DefinitionContribution` union of modules.ts (module-catalog.ts:143) while modules.ts calls installedModules; give the module descriptor and contribution types a home below both.",
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
  {
    lint: "module-cycle",
    reason: "A module's protocol home builds `ClientCommand` literals of the host contract (protocol/modules/project-notifications.ts:141, NotificationActionView.open), while the shared client core reads the module domains, schemas, and delivery policy that the runtime-* files compose from protocol/modules. Next cut: give `ClientCommand`, `SheetFocus`, and `ClientSheetId` a home in src/protocol below both client and modules, and import it in host-contract.ts and every host.",
    key: [
      "flywheel::protocol::client",
      "flywheel::protocol::modules",
      "flywheel::protocol::runtime-client-deadlines",
      "flywheel::protocol::runtime-cursor-schemas",
      "flywheel::protocol::runtime-delivery-policy",
      "flywheel::protocol::runtime-dispatch-result-schemas",
      "flywheel::protocol::runtime-protocol-schemas",
    ].join(","),
  },
  {
    lint: "module-cycle",
    reason: "The shell owners are grouped by concern (docs/architecture.md, the shell composition site), but they build in phases: the composer core, then the places, the overlays, the navigation, and last the commands and prompt area. shell-composer.tsx holds the first and last phases and shell-navigation.ts the second and fourth, so each file reads the other's results. Next cut: move createShellComposer to its own file below createShellPlaces, and createShellPlaces out of shell-navigation.ts, so each file holds one phase; update the composition order in docs/architecture.md.",
    key: [
      "flywheel::tui::shell-composer",
      "flywheel::tui::shell-navigation",
      "flywheel::tui::shell-overlays",
    ].join(","),
  },
];
