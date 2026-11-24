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
    reason: "vm folds the facts that workflow-root, session-fact-source, and context-bundle write, while they decode facts through vm's parseWorkflowSessionFact and workflowAggregateId, view reads vm's recovery, and definition-provenance-facts reads vm's DefinitionIdentityMismatchSchema; give the workflow session fact union, the aggregate id, and the identity-mismatch schema a home below vm, then reassess.",
    key: [
      "flywheel::workflows::context-bundle",
      "flywheel::workflows::definition-provenance-facts",
      "flywheel::workflows::session-fact-source",
      "flywheel::workflows::view",
      "flywheel::workflows::vm",
      "flywheel::workflows::workflow-root",
    ].join(","),
  },
  {
    lint: "module-cycle",
    reason: "`hooks` holds both the primitive hooks that components use (useHoverHighlight, useSpinnerFrame, createMeasuredWidth, the draft cache) and the shell wiring that renders components, modals, and the output window (shell-state, create-modals); move the primitive hooks below components, then reassess.",
    key: [
      "flywheel::tui::commands",
      "flywheel::tui::components",
      "flywheel::tui::hooks",
      "flywheel::tui::modals",
      "flywheel::tui::output-blocks",
      "flywheel::tui::output-window",
      "flywheel::tui::question-dock",
      "flywheel::tui::session-picker",
      "flywheel::tui::welcome-notice",
    ].join(","),
  },
  {
    lint: "module-cycle",
    reason: "The cheapest tie: `auth` uses `llm` by 34 items, against 43 the other way. Move all of them below both: the access-provider definitions, external-account and profile-conversion shapes (auth-context, auth-profile-normalization, web-providers), catalog row validation, limits and transport (provider-model-catalog-store), preference transitions and canonicalModelId (provider-model-preference-store), and the subscription account identity (subscription-spend-consent and its store).",
    key: [
      "flywheel::infra::auth",
      "flywheel::infra::llm",
    ].join(","),
  },
  { lint: "shallow-module", key: "flywheel::infra::update", reason: "Shows more functions than it hides; narrow its exports to the update operations that callers use." },
  { lint: "shallow-module", key: "flywheel::orchestration::auth::provider-observations", reason: "SubscriptionUsageServicePool shows most of its methods; give callers one narrow usage-service interface." },
  { lint: "shallow-module", key: "flywheel::orchestration::runner", reason: "OutputSession and the host types show most of their methods; narrow the runner interface that callers see." },
  { lint: "shallow-module", key: "flywheel::orchestration::session-store", reason: "SessionStore shows 31 methods that mix jobs; split it by job." },
  { lint: "shallow-module", key: "flywheel::protocol::client", reason: "The shared client core shows most of its functions; narrow each controller to what the client hosts call." },
  { lint: "shallow-module", key: "flywheel::tui::transcript-store", reason: "OutputTranscriptCache shows 27 functions and hides almost none; put a narrower cache interface in front of it." },
  { lint: "shallow-module", key: "flywheel::tui::utils", reason: "A catch-all of unrelated helpers; move each helper to the one domain that uses it." },
  { lint: "wide-directory", key: "src/cli/", reason: WIDE },
  { lint: "wide-directory", key: "src/infra/", reason: WIDE },
  { lint: "wide-directory", key: "src/infra/auth/", reason: WIDE },
  { lint: "wide-directory", key: "src/infra/llm/", reason: WIDE },
  { lint: "wide-directory", key: "src/infra/output/", reason: WIDE },
  { lint: "wide-directory", key: "src/orchestration/", reason: WIDE },
  { lint: "wide-directory", key: "src/orchestration/agent-runtime/", reason: WIDE },
  { lint: "wide-directory", key: "src/orchestration/agent-runtime/llm/", reason: WIDE },
  { lint: "wide-directory", key: "src/orchestration/agent-runtime/tools/", reason: WIDE },
  { lint: "wide-directory", key: "src/orchestration/app-service/", reason: WIDE },
  { lint: "wide-directory", key: "src/orchestration/chat/", reason: WIDE },
  { lint: "wide-directory", key: "src/orchestration/config/", reason: WIDE },
  { lint: "wide-directory", key: "src/orchestration/modules/development/benchmark/", reason: WIDE },
  { lint: "wide-directory", key: "src/orchestration/modules/experiments/", reason: WIDE },
  { lint: "wide-directory", key: "src/orchestration/modules/learning/", reason: WIDE },
  { lint: "wide-directory", key: "src/orchestration/modules/mcp/", reason: WIDE },
  { lint: "wide-directory", key: "src/orchestration/modules/provider-claude-agent-sdk/", reason: WIDE },
  { lint: "wide-directory", key: "src/orchestration/modules/provider-google-antigravity/", reason: WIDE },
  { lint: "wide-directory", key: "src/orchestration/modules/remote/", reason: WIDE },
  { lint: "wide-directory", key: "src/orchestration/modules/subagents/execution/", reason: WIDE },
  { lint: "wide-directory", key: "src/orchestration/modules/workflows/", reason: WIDE },
  { lint: "wide-directory", key: "src/orchestration/session/", reason: WIDE },
  { lint: "wide-directory", key: "src/orchestration/session/conversation/", reason: WIDE },
  { lint: "wide-directory", key: "src/orchestration/workflow-host/", reason: WIDE },
  { lint: "wide-directory", key: "src/protocol/", reason: WIDE },
  { lint: "wide-directory", key: "src/protocol/client/", reason: WIDE },
  { lint: "wide-directory", key: "src/tui/", reason: WIDE },
  { lint: "wide-directory", key: "src/tui/components/", reason: WIDE },
  { lint: "wide-directory", key: "src/tui/context/", reason: WIDE },
  { lint: "wide-directory", key: "src/tui/hooks/", reason: WIDE },
  { lint: "wide-directory", key: "src/tui/modals/", reason: WIDE },
  { lint: "wide-directory", key: "src/tui/output-blocks/", reason: WIDE },
  { lint: "wide-directory", key: "src/workflows/", reason: WIDE },
  { lint: "wide-directory", key: "src/workflows/vm/", reason: WIDE },
  { lint: "wide-directory", key: "vscode/src/runtime/", reason: WIDE },
  { lint: "wide-directory", key: "webview/src/app/", reason: WIDE },
  { lint: "wide-directory", key: "webview/src/app/sheets/", reason: WIDE },
  { lint: "wide-directory", key: "webview/src/client/", reason: WIDE },
  {
    lint: "module-cycle",
    reason: "Cutting the cheapest printed tie (`agent-runtime` uses `module-requirements`) leaves this circle unchanged. Cut `definition-health` -> `definition-catalog`: give the skill health summary the installed definition registry from its composition instead of calling createInstalledDefinitionRegistry.",
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
