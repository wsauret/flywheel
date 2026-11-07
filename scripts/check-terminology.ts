import * as fs from "node:fs";
import * as path from "node:path";

// Terminology gate (docs/terminology.md). Each entry retires one synonym in
// favor of the canonical lexicon term. A new retirement starts inactive and flips active
// once its rename lands, so the gate ratchets without failing on debt the
// rename has not yet reached. Slice numbers are stable identifiers from the
// completed 2026-08 remediation program; new entries continue the numbering.
// This is a line-based scan rather than an AST rule because the retired terms
// span identifiers, string literals, file paths, YAML, and prose with one
// mechanism.
//
// Scope: src/ code, skill and workflow definition bodies, the editor host and
// the web client, docs/architecture-intent/, docs/product-intent/,
// docs/elegance.md, docs/architecture.md, AGENTS.md, README.md, and, where the
// maintainer's private companion checkout exists, its instructions and
// release playbooks. The lexicon
// itself (docs/terminology.md) names retired terms by design and is excluded.
//
// Census mode (`--census`) reports hit counts for every term including
// inactive ones, for slice planning. It always exits 0.

type Scope = "all" | "docs";

interface RetiredTerm {
  /** Matched against each line. Word-bound for identifiers, loose for paths. */
  pattern: RegExp;
  /** The canonical replacement per docs/terminology.md, shown in the failure. */
  replacement: string;
  /** Stable grouping id from the 2026-08 remediation program; new entries
   *  continue the numbering. */
  slice: number;
  active: boolean;
  /** "docs" restricts prose terms to Markdown and YAML surfaces. */
  scope?: Scope;
  /** Repo-relative path fragments where the term is sanctioned boundary vocabulary. */
  allowPaths?: readonly string[];
  /** When present, the term applies only to files whose repo-relative path
   *  matches one of these. A word with a kernel sense elsewhere, such as the
   *  serve lane or a procedure step, is retired only where its workflow sense
   *  is the only sense. */
  onlyPaths?: readonly RegExp[];
  /** Sanctioned line shapes, e.g. tolerant decoders of historical spellings. */
  allowLines?: readonly RegExp[];
}

/** Where a workflow-sense word is the only sense: the workflow layers, the
 *  workflow surfaces of each client, the authoring guide, and the product
 *  intent. */
const WORKFLOW_PATHS: readonly RegExp[] = [
  /^src\/workflows\//,
  /^src\/orchestration\/workflow-host\//,
  /^src\/orchestration\/modules\/workflows\//,
  /^src\/protocol\/client\/workflow-/,
  /^src\/protocol\/brief-role-id\.ts$/,
  /^src\/tui\/(.*\/)?workflow-/,
  /^webview\/src\/(.*\/)?workflow-/,
  /^src\/orchestration\/modules\/workflows\/definitions\/skills\/workflow-authoring\//,
  /^docs\/product-intent\//,
];

/** Files whose job is to read the shapes that earlier releases stored: the
 *  converter of the step grammar, the frozen identities, codecs, and built-in
 *  definitions, the dated conversions, and the store migrations. A retired
 *  spelling there is the spelling that they convert. */
const HISTORY_PATHS: readonly string[] = [
  "src/workflows/retired-step-grammar/",
  "/retired-",
  "/historical-",
  "/legacy-",
  "/migrations/",
  // The view of a run that the step grammar recorded, read for history only.
  "src/workflows/view/view-history-tree.ts",
  // Recorded calls of the retired step tool.
  "src/infra/tools/displays/step.ts",
];

/** Line shapes that hold a stored spelling, which a release before the agent
 *  lexicon wrote and which a reader must still match word for word. */
const STORED_LINES: readonly RegExp[] = [
  // A line that names the retired thing it converts.
  /\b[Rr]etired|RETIRED_/,
  // An explicit note on a stored spelling, or a stored value in backticks.
  /[Ss]tored (keys?|spellings?|literals?|types?|ids?|kinds?|text|payload key|migration id|notification text|`)/,
  // The name of the retired grammar.
  /step[- ]grammar/i,
  // Frozen fact, event, and diagnostic types, such as `workflow.step.started`.
  /["'`](\w+\.)*step\.[\w.@]+["'`]/,
  // Stored kind tokens.
  /(kind|_tag|component)\s*(:|===|!==)\s*["']step["']|Literals?\(\[[^\]]*["']step["']|TaggedStruct\("step"|case "step"/,
  // Imports of history modules.
  /from "[^"]*(retired-step-|\/migrations\/|legacy-step)/,
  // Divider block ids that clients hold.
  /:step:/,
  // The stored entry id prefix of a workflow task.
  /workflow-step-task:/,
  // Recorded migration reasons.
  /^\s*"Control (recorded|was staged)/,
  // The ARIA token "step".
  /aria-current/,
];

/** Ordinary prose for one action of a procedure, which keeps step (docs/terminology.md). */
const ORDINAL_LINES: readonly RegExp[] = [/\b(next|first|one) step\b|step[- ]by[- ]step/i];

/** Kernel senses of the prose words that a workflow path still names: the
 *  connection lane of a client, and the ordered lane primitive of infra. */
const KERNEL_SENSE_LINES: readonly RegExp[] = [
  /\/infra\/ordered-lane\.js"/,
  /\bconnection lanes?\b/i,
  /\b(fakeLanes|onLane|lostWithLane|LANE_BREAK)\b/,
  /\blanes\.(end|open|onLane)\b/,
];

/** The protocol version notes name the wire keys that each version retired. */
const PROTOCOL_VERSION_NOTES = "src/protocol/runtime-liveness.ts";

/** Decoders of stored keys that a release before the agent lexicon wrote. Each
 *  file keeps `stepId`, `stepIds`, or `stepName` only where it reads a stored
 *  shape. Control v11 keeps its keys, because U0 adds no control version. */
const STORED_STEP_KEY_READERS: readonly string[] = [
  // The handoff v1 decoder.
  "src/workflows/output-contract/facts.ts",
  // The context v1 to v5 decoders.
  "src/workflows/context-bundle/context-facts.ts",
  // The improvement v1 decoder.
  "src/workflows/improvements/improvement-facts.ts",
  // The attempt facts of view v1.
  "src/workflows/view/view-facts.ts",
  // The view tree v3 and the rows v9.
  "src/workflows/view/schemas.ts",
  // workflow.compiled v8 to v10.
  "src/workflows/definition-provenance-facts.ts",
  // The persona and brief identities that recorded runs hash.
  "src/workflows/vm/definition-identity.ts",
  "src/workflows/vm/session-facts.ts",
  "src/workflows/vm/node-outputs.ts",
  // The stored keys of control v11: `steps[].stepId`, the handoff evidence
  // `stepId`, and the join slot `step_id`.
  "src/workflows/reducers/reducer.ts",
  // Readers of the view that the step grammar recorded.
  "src/workflows/agent-resolution.ts",
  "src/workflows/context-bundle/context.ts",
  // The event search formatter and the decode-only schema of the older usage fact.
  "src/infra/runtime-fact-types.ts",
  "src/cli/event-search-format.ts",
  "src/orchestration/agent-runtime/usage-settlement.ts",
  "src/orchestration/session/provider-request-audit-facts.ts",
  "src/orchestration/session/provider-request-audit-projection.ts",
  PROTOCOL_VERSION_NOTES,
];

function identifierTerms(entries: readonly (readonly [RegExp, string, (readonly string[])?, (readonly RegExp[])?])[]): RetiredTerm[] {
  return entries.map(([pattern, replacement, allowPaths = [], allowLines = []]) => ({
    pattern,
    replacement,
    slice: 18,
    active: true,
    allowPaths: [...HISTORY_PATHS, ...allowPaths],
    allowLines: [...STORED_LINES, ...allowLines],
  }));
}

function workflowProseTerms(entries: readonly (readonly [RegExp, string, (readonly string[])?])[]): RetiredTerm[] {
  return entries.map(([pattern, replacement, allowPaths = []]) => ({
    pattern,
    replacement,
    slice: 18,
    active: true,
    onlyPaths: WORKFLOW_PATHS,
    allowPaths: [...HISTORY_PATHS, ...allowPaths],
    allowLines: [...STORED_LINES, ...ORDINAL_LINES, ...KERNEL_SENSE_LINES],
  }));
}

const RETIRED_TERMS: readonly RetiredTerm[] = [
  // Active from day one: verified clean, the gate holds the line.
  {
    pattern: /\bplugin\b/i,
    replacement: "module (docs/terminology.md)",
    slice: 1,
    active: true,
    allowPaths: [
      "src/vendor.d.ts",
      "src/tui/launcher.ts",
      "src/orchestration/modules/provider-github-copilot/auth-types.ts",
      // The Agent SDK bridge loads an engine plugin through the SDK's `plugins` option.
      "src/orchestration/modules/provider-claude-agent-sdk/",
      // A benchmark comparison arm loads an external CLI's plugin through its `--plugin-dir` option.
      "src/orchestration/modules/development/benchmark/",
      // A Babel plugin package is named by its published package name.
      "webview/src/test-support/solid-transform.ts",
      // Rejection prose: these statements name plugin to reject it as the module noun.
      "docs/architecture-intent/naming.md",
      "docs/architecture-intent/structure.md",
    ],
  },
  {
    pattern: /\bdaemon\b/i,
    replacement: "IDE runtime daemon only (docs/terminology.md)",
    slice: 1,
    active: true,
    // systemd's own command, as an argv or inside a shell script.
    allowLines: [/(?:["']systemctl daemon-reload["']|["']systemctl["'].*["']daemon-reload["']|systemctl --user daemon-reload)/],
    allowPaths: [
      // Rejection prose: this statement names a detached daemon to reject it.
      "docs/architecture-intent/runtime.md",
      // The IDE runtime is the one process placement the glossary names a daemon.
      "vscode/src/runtime/runtime-resolver.ts",
      "vscode/src/runtime/supervisor.ts",
      "vscode/src/runtime/supervisor.test.ts",
      // Repo-agnostic reviewer vocabulary about arbitrary software.
      "src/workflows/agents/personas/reviewer-mechanism.md",
    ],
  },

  // Slice 2: event and fact alignment.
  { pattern: /\bStoredEvent\b/, replacement: "StoredFact", slice: 2, active: true },
  { pattern: /\bSessionEventWriter\b/, replacement: "SessionFactWriter", slice: 2, active: true },
  { pattern: /\beventTypes\b/, replacement: "factTypes", slice: 2, active: true },

  // Slice 3: step and attempt unification.
  { pattern: /\bWorkflowQueueStep\b/, replacement: "AttemptRow", slice: 3, active: true },
  { pattern: /\bFrontendStepState\b/, replacement: "FrontendStep", slice: 3, active: true },
  { pattern: /\bConcreteAttempt\b/, replacement: "Attempt", slice: 3, active: true },
  { pattern: /\bExecutableUnit\b/, replacement: "AgentNode", slice: 3, active: true },
  { pattern: /\bWorkflowBinding\b/, replacement: "WorkflowPhase, or an agent record (AgentRecordRef)", slice: 3, active: true },
  { pattern: /\bBoundSkill\b/, replacement: "ResolvedAgent", slice: 3, active: true },
  { pattern: /\bstepForAttempt\b/, replacement: "attemptRowFor (builds the agent's row input)", slice: 3, active: true },
  { pattern: /\bRetryAttempt\b/, replacement: "RetryState (attempt is the workflow try word)", slice: 3, active: true },
  { pattern: /\bstep_definition\b/, replacement: "skill_definition", slice: 3, active: true },

  // Slice 4: workflow view replaces queue.
  { pattern: /\bLiveQueueView\b/, replacement: "WorkflowView", slice: 4, active: true },
  { pattern: /\bWorkflowQueueStore\b/, replacement: "WorkflowViewStore", slice: 4, active: true },
  { pattern: /\bflattenWorkflowQueue\b/, replacement: "flattenWorkflowView", slice: 4, active: true },
  { pattern: /\bqueueForWorkflowProposal\b/, replacement: "workflowViewForProposal", slice: 4, active: true },
  { pattern: /\bFrontendQueueStatus\b/, replacement: "FrontendWorkflowState", slice: 4, active: true },
  { pattern: /\bQueueStatus\b/, replacement: "WorkflowState", slice: 4, active: true },
  { pattern: /\bcreateQueueCache\b/, replacement: "createWorkflowViewCache", slice: 4, active: true },
  { pattern: /queue-protocol-types/, replacement: "workflow-view-protocol-types", slice: 4, active: true },

  // Slice 5: conversation, session, and transcript stems.
  { pattern: /\bSessionTree\w*/, replacement: "ConversationTree*", slice: 5, active: true },
  { pattern: /\bChatTree\w+/, replacement: "ConversationTree*", slice: 5, active: true },
  { pattern: /\bThreadHistory\w*/, replacement: "BranchHistory*", slice: 5, active: true },
  { pattern: /\bresumeConversationId\b/, replacement: "providerSessionKey", slice: 5, active: true },
  { pattern: /\bdurableConversationId\b/, replacement: "conversationId", slice: 5, active: true },
  { pattern: /\bOutputHistory\w+/, replacement: "Transcript*", slice: 5, active: true },
  { pattern: /output-history-/, replacement: "transcript-", slice: 5, active: true },
  { pattern: /\bscrollback\b/i, replacement: "transcript", slice: 5, active: true },
  { pattern: /\brendered history\b/i, replacement: "transcript", slice: 5, active: true, scope: "docs" },

  // Slice 6: agent, runner, host, and step agent.
  { pattern: /\bFlywheelAgentRunner\b/, replacement: "LiveAgent", slice: 6, active: true },
  { pattern: /\bAgentRunner\w*/, replacement: "Agent*", slice: 6, active: true },
  { pattern: /\bRunnerHost\w*/, replacement: "AgentHost*", slice: 6, active: true },
  { pattern: /\bRunnerContext\b/, replacement: "(delete; a no-op alias of Agent)", slice: 6, active: true },
  { pattern: /\bBaseRunner\b/, replacement: "Runner", slice: 6, active: true },
  { pattern: /\bAttemptRunner\b/, replacement: "AttemptExecutor", slice: 6, active: true },
  { pattern: /\bWorkerOutcome\b/, replacement: "AgentOutcome", slice: 6, active: true },
  { pattern: /\bWorkerOutput\b/, replacement: "AgentOutput", slice: 6, active: true },
  { pattern: /\bWorkerFailureKind\b/, replacement: "AgentFailureKind", slice: 6, active: true },
  { pattern: /\bstep-worker\b/, replacement: "workflow-agent", slice: 6, active: true, allowPaths: ["src/orchestration/config/retired-config-names.ts"], allowLines: [/Retired spelling/] },
  { pattern: /\bOrchestrator\b/, replacement: "Workflow Agent (the label names the workflow-agent role)", slice: 6, active: true },
  { pattern: /\bChatHostPorts\b/, replacement: "ChatPorts", slice: 6, active: true },
  { pattern: /\bopenChatShell\b/, replacement: "openSessionRuntime", slice: 6, active: true },
  { pattern: /\bChatShellOptions\b/, replacement: "SessionRuntimeOptions", slice: 6, active: true },
  { pattern: /\bBlockShell\b/, replacement: "BlockFrame", slice: 6, active: true },
  { pattern: /quiesc/i, replacement: "settle stem (settled, settlement)", slice: 6, active: true },

  // Slice 7: module and capability.
  { pattern: /\bcapability_modules\b/, replacement: "modules (config key)", slice: 7, active: true, allowLines: [/retired spelling/i, /capability_modules is its retired/, /hasRetiredSpelling/, /Object.hasOwn/, /removeRootAssignment/, /\?\? parsed\[/]  },
  { pattern: /\bCapabilityModule\w*/, replacement: "ModuleDescriptor / ModuleId", slice: 7, active: true },
  { pattern: /\bGuardianCapability\b/, replacement: "GuardianToken", slice: 7, active: true },
  { pattern: /\bMcpCapability\b/, replacement: "McpPorts", slice: 7, active: true },
  { pattern: /\bRecallCapability\b/, replacement: "RecallPort", slice: 7, active: true },
  { pattern: /\bWebSearchCapability\b/, replacement: "WebSearchPort", slice: 7, active: true },
  { pattern: /\bMutationCapability\b/, replacement: "MutationPort", slice: 7, active: true },
  { pattern: /harness-capabilit/, replacement: "module-policy naming", slice: 7, active: true },
  { pattern: /\bharness capabilit(y|ies)\b/i, replacement: "modules", slice: 7, active: true, scope: "docs" },
  { pattern: /\bbackground_commands\b/, replacement: "background-commands (kebab module id)", slice: 7, active: true, allowLines: [/RETIRED_MODULE_ID_SPELLINGS/, /features/, /legacy/i]  },

  // Slice 8: states and activity.
  { pattern: /\bModelPhase\b/, replacement: "Activity", slice: 8, active: true },
  { pattern: /\bFrontendModelPhase\b/, replacement: "FrontendActivity", slice: 8, active: true },
  { pattern: /\brunnerActivity\b/, replacement: "activity", slice: 8, active: true },
  { pattern: /\bFrontendRunnerActivity\b/, replacement: "FrontendActivity", slice: 8, active: true },

  // Slice 9: tools. toolUseId stayed canonical: ~50 durable fact payload
  // schemas store the key, so toolCallId would have split the codebase into
  // two vocabularies. The glossary records the correction; toolCallId retired.
  { pattern: /\btoolCallId\b/, replacement: "toolUseId (stored payload key is canonical)", slice: 9, active: true, allowLines: [/stored spelling/i, /toolCallId: toolUseId/, /toolCallId\?: string/, /tool_call_id/, /LaunchedFrom/, /launchedFrom/] },
  { pattern: /\bToolInvocation\w*/, replacement: "tool call vocabulary", slice: 9, active: true },

  // Slice 10: providers.
  { pattern: /\bLlmProvider\b/, replacement: "ModelFamily", slice: 10, active: true },
  { pattern: /chatgpt-backend/, replacement: "chatgpt-adapter", slice: 10, active: true },
  { pattern: /\bBackend(ApiError|Transport|Event)\b/, replacement: "Adapter*", slice: 10, active: true },
  { pattern: /\bProviderChain(Client|Plan)\b/, replacement: "Failover*", slice: 10, active: true },

  // Slice 11: compaction and learning.
  { pattern: /\bsummarizeForCompaction\b/, replacement: "compaction stem naming", slice: 11, active: true },
  { pattern: /\brunCompactionSummary\b/, replacement: "compaction stem naming", slice: 11, active: true },
  { pattern: /\bcreateSummarizer\b/, replacement: "reset compaction (no summarizer exists)", slice: 11, active: true },
  { pattern: /\bshouldSummarize\b/, replacement: "shouldCompact", slice: 11, active: true },
  { pattern: /\bselectUnwindTail\b/, replacement: "emergency trim naming", slice: 11, active: true },
  { pattern: /\bEMERGENCY_UNWIND_POLICY\b/, replacement: "emergency trim naming", slice: 11, active: true },
  { pattern: /\belideOlderImageParts\b/, replacement: "dropOlderImageParts", slice: 11, active: true },
  { pattern: /\bnormalizeCompactWorkerHandoff\b/, replacement: "Terse* naming (compact means compaction)", slice: 11, active: true },
  { pattern: /\breflect(Session|Conversation|Chat)\b/, replacement: "learn verb", slice: 11, active: true },
  { pattern: /\bchat\.reflect\b/, replacement: "chat.learn", slice: 11, active: true },
  { pattern: /self[-_]improvement/i, replacement: "learning review", slice: 11, active: true, allowLines: [/OBSOLETE_LEARNING_SECTION/, /"self_improvement"/, /retired spelling/i]  },
  { pattern: /\bskill-review\b/, replacement: "learning-review", slice: 11, active: true, allowPaths: ["src/orchestration/config/retired-config-names.ts"] },
  { pattern: /\bLearningReach\b/, replacement: "LearningScope", slice: 11, active: true },
  { pattern: /audit-journal/, replacement: "learning-journal", slice: 11, active: true },

  // Slice 12: read models, registries, observability.
  { pattern: /rehydrat/i, replacement: "replay (whole history) or fold (one batch)", slice: 12, active: true },
  { pattern: /\bcatchUp\b/, replacement: "replay", slice: 12, active: true },
  { pattern: /"runtime-projection"/, replacement: '"runtime-owned"', slice: 12, active: true },

  // Slice 13: config, settings, CLI.
  { pattern: /\bstoreKey\b/, replacement: "id (one id per setting)", slice: 13, active: true },
  // "preferences" is banned only as a config-drawer synonym; the word legitimately
  // names remembered user preferences (learning memory), so review polices the
  // config sense instead of this gate.
  { pattern: /\bpreferences\b/i, replacement: "settings (config sense only)", slice: 13, active: false },
  { pattern: /\b(events|trace|skills|memory|workflow):(search|list|why|restore|prune|show|verify|maintain)\b/, replacement: "space subcommand grammar (flywheel events search)", slice: 13, active: true, scope: "docs", allowLines: [/bun run/] },
  { pattern: /--base-dir\b/, replacement: "--project-root", slice: 13, active: true, allowLines: [/retired spelling/i] },

  // Slice 14: subagents, prompt, composer, TUI chrome.
  { pattern: /\bsubagent_type\b/, replacement: "persona", slice: 14, active: true },
  { pattern: /\bBackgroundTaskRegistry\b/, replacement: "BackgroundWorkRegistry", slice: 14, active: true },
  { pattern: /\bPromptArea\b/, replacement: "Composer", slice: 14, active: true },
  { pattern: /prompt-area/, replacement: "composer", slice: 14, active: true },
  { pattern: /prompt-history/, replacement: "composer-history", slice: 14, active: true },
  { pattern: /\bDialog(Stack|Provider|Handle)\b/, replacement: "Modal*", slice: 14, active: true },
  { pattern: /\bopen\w+Dialog\b/, replacement: "open*Modal", slice: 14, active: true },
  { pattern: /(lineage|status)-dialog/, replacement: "*-modal", slice: 14, active: true },
  { pattern: /\bbanner\b/i, replacement: "notice (toast is transient, notice is pinned; docs/terminology.md)", slice: 14, active: true },

  // Slice 17: protocol requests are mutations (Grammar 2); command belongs to slash commands.
  { pattern: /\bFrontendCommand\b/, replacement: "FrontendMutation", slice: 17, active: true },
  { pattern: /\bCommandResult\b/, replacement: "MutationResult", slice: 17, active: true },
  { pattern: /\bdispatchFrontendCommand\b/, replacement: "dispatchFrontendMutation", slice: 17, active: true },

  // Slice 15: identifier composition cleanup.
  { pattern: /\breadBy[A-Z]\w+\b/, replacement: "read(query) filter object on the fact reader", slice: 15, active: true },
  { pattern: /\bFactoryCompletedRuntimeToolSurfaces\b/, replacement: "RuntimeToolSurfaces", slice: 15, active: true },
  { pattern: /\bLegacy\w+Schema\b/, replacement: "versioned decoder naming (facts carry version fields)", slice: 15, active: true },
  { pattern: /\breconcileAndRead\w+/, replacement: "readReconciled* (the reconcile is the read's consistency precondition)", slice: 15, active: true },

  // Slice 16: docs and ADR convergence.
  { pattern: /\bcanonical practice packages?\b/i, replacement: "skill", slice: 16, active: true },
  { pattern: /\bpractice packages?\b/i, replacement: "skill package", slice: 16, active: true },
  { pattern: /\binstruction packages?\b/i, replacement: "skill package", slice: 16, active: true },
  { pattern: /\bingredient\b/i, replacement: "dependency", slice: 16, active: true, scope: "docs" },
  {
    pattern: /\bpipeline\b/i,
    replacement: "workflow",
    slice: 16,
    active: true,
    scope: "docs",
  },

  // Slice 18: one workflow lexicon (docs/terminology.md): a workflow lists phases, a phase
  // has agents, an agent runs a brief on at most one item, and each try is an
  // attempt. Identifiers retire everywhere; the workflow-sense prose words
  // retire only under WORKFLOW_PATHS, where they have no kernel sense.
  ...identifierTerms([
    [/\bstepId\b/, "attemptId, definitionId, or nodeId (the name of the value it holds)", STORED_STEP_KEY_READERS],
    [/\bstepIds\b/, "definitionIds or attemptIds", STORED_STEP_KEY_READERS],
    [/\bstepName\b/, "agentName", STORED_STEP_KEY_READERS],
    [/\bStepAgent/, "the Agent stem, as in WorkflowAgent"],
    [/\bstep-agent\b/, "workflow-agent", [
      PROTOCOL_VERSION_NOTES,
      // The config reader converts the role ids that earlier releases saved.
      "src/orchestration/config/retired-config-names.ts",
      // The task prompts are hashed into the identity of every recorded
      // persona benchmark run, so their text stays as recorded.
      "src/orchestration/modules/development/benchmark/catalog.ts",
    ]],
    [/\bstepBoundary\b/, "divider", [PROTOCOL_VERSION_NOTES]],
    [/\bleafId\b/, "agentNodeId or nodeId", [
      // The web client reads the agent of a browser history entry that a
      // build before 2026-10-16 wrote under `leafId`, and its test feeds one.
      "webview/src/client/workflow-agent.ts",
      "webview/src/client/workflow-agent.test.ts",
      // The conversation tree names the newest entry of a branch its leaf (ARCH-SESSIONS-047).
      "src/orchestration/session/",
      // Request startup selects the conversation tree's recorded masking epoch.
      "src/orchestration/agent-runtime/active-request-context.ts",
    ], [/"leafId" in /]],
    [/\blaneSteps?\b/, "agentParts"],
    [/\bcontentId\b/, "briefId", [
      // A hash key of briefContentSha256 that recorded runs hold.
      "src/workflows/vm/definition-identity.ts",
      "src/workflows/view/schemas.ts",
      "src/workflows/view/view-facts.ts",
      "src/workflows/definition-provenance-facts.ts",
      PROTOCOL_VERSION_NOTES,
    ]],
    [/\bfan-?out\b/i, "parallel dispatch, or a phase over a list; fan-out is not a noun (glossary join)"],
  ]),
  ...workflowProseTerms([
    [/\bsteps?\b/i, "phase, agent, attempt, or brief (pick the word by the value)"],
    // The view tree v3 stores `stages` and `stageIds`.
    [/\bstages?\b/i, "a phase of a stream", ["src/workflows/view/schemas.ts"]],
    // An improvement lane is a proposal route, not the agents of one item.
    [/\blanes?\b/i, "item, or the agents of one item", ["src/workflows/improvements/"]],
    [/\bmap (entry|over)\b/i, "a phase over a list"],
    [/\bleaf\b/i, "agent"],
    [/\bconcurrent span\b/i, "a phase of named agents, or a stream"],
    [/\bstep agent\b/i, "an agent of a workflow"],
    [/\bstep content\b/i, "brief"],
  ]),
  // A workflow shows its card, whose phase lines list their agents; the
  // version notes name the block kind that version 56 retired.
  { pattern: /\broster\b/i, replacement: "the agents of a phase", slice: 18, active: true, onlyPaths: WORKFLOW_PATHS, allowPaths: [...HISTORY_PATHS, PROTOCOL_VERSION_NOTES] },
  { pattern: /\bworkflowRoster\b/, replacement: "the card's agent lines; version 56 retired the roster block", slice: 18, active: true, allowPaths: [...HISTORY_PATHS, PROTOCOL_VERSION_NOTES] },
  { pattern: /\bstrip\b/i, replacement: "the card's phase line", slice: 18, active: true, onlyPaths: WORKFLOW_PATHS, allowPaths: [...HISTORY_PATHS, PROTOCOL_VERSION_NOTES] },
  // Slice 19: agents write and launch workflows through one module.
  // In a string literal, an escaped newline before the term has no word boundary.
  ...[
    { pattern: /(?:\b|\\n)ad[ -]hoc workflows?\b/i, replacement: "workflow" },
    { pattern: /\badhoc-workflows\b/, replacement: "workflows (module id)" },
    { pattern: /\bregistered workflows?\b/i, replacement: "workflow" },
  ].map((term) => ({
    ...term,
    slice: 19,
    active: true,
    allowPaths: [...HISTORY_PATHS, PROTOCOL_VERSION_NOTES],
    // A dated conversion names the retired thing; a recorded reminder statement keeps its stored text.
    allowLines: [...STORED_LINES.slice(0, 1), /^\s*"<system-reminder>\\n/],
  })),
];

const DOC_EXTENSIONS = new Set([".md", ".yaml", ".yml"]);
const CODE_EXTENSIONS = new Set([".ts", ".tsx"]);

const EXCLUDED_FILES = new Set(["docs/terminology.md"]);

interface Violation {
  file: string;
  line: number;
  match: string;
  term: RetiredTerm;
}

function walk(dir: string, out: string[]): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, out);
      continue;
    }
    if (!entry.isFile()) continue;
    const ext = path.extname(entry.name);
    if (DOC_EXTENSIONS.has(ext) || CODE_EXTENSIONS.has(ext)) out.push(full);
  }
}

/** A repository-relative path in the POSIX form every exclusion and allowlist
 *  in this file is written in. `path.relative` answers in native separators, so
 *  on Windows an entry such as "src/vendor.d.ts" would never match and every
 *  sanctioned use of a retired term would be reported. */
function repoRelative(repoRoot: string, file: string): string {
  return path.relative(repoRoot, file).replaceAll(path.sep, "/");
}

function scanTargets(repoRoot: string): string[] {
  const files: string[] = [];
  walk(path.join(repoRoot, "src"), files);
  walk(path.join(repoRoot, "vscode", "src"), files);
  walk(path.join(repoRoot, "webview", "src"), files);
  walk(path.join(repoRoot, "docs", "architecture-intent"), files);
  walk(path.join(repoRoot, "docs", "product-intent"), files);
  files.push(path.join(repoRoot, "docs", "elegance.md"), path.join(repoRoot, "docs", "architecture.md"), path.join(repoRoot, "docs", "terminology.md"), path.join(repoRoot, "AGENTS.md"), path.join(repoRoot, "README.md"));
  // A clone without the maintainer's private companion checkout has neither.
  const maintainerInstructions = path.join(repoRoot, "private", "AGENTS.maintainer.md");
  if (fs.existsSync(maintainerInstructions)) files.push(maintainerInstructions);
  const playbooks = path.join(repoRoot, "private", "docs", "playbooks");
  if (fs.existsSync(playbooks)) walk(playbooks, files);
  return files.filter((f) => !EXCLUDED_FILES.has(repoRelative(repoRoot, f)));
}

function isDocSurface(file: string): boolean {
  return DOC_EXTENSIONS.has(path.extname(file));
}

function termApplies(term: RetiredTerm, relPath: string, docSurface: boolean): boolean {
  if (term.scope === "docs" && !docSurface) return false;
  if (term.onlyPaths !== undefined && !term.onlyPaths.some((p) => p.test(relPath))) return false;
  if (term.allowPaths?.some((p) => relPath.includes(p))) return false;
  return true;
}

function scan(repoRoot: string, includeInactive: boolean): Violation[] {
  const out: Violation[] = [];
  for (const file of scanTargets(repoRoot)) {
    const relPath = repoRelative(repoRoot, file);
    const docSurface = isDocSurface(file);
    const terms = RETIRED_TERMS.filter(
      (t) => (includeInactive || t.active) && termApplies(t, relPath, docSurface),
    );
    if (terms.length === 0) continue;
    const lines = fs.readFileSync(file, "utf8").split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      const text = lines[index] ?? "";
      for (const term of terms) {
        const match = text.match(term.pattern);
        if (!match) continue;
        if (term.allowLines?.some((a) => a.test(text))) continue;
        out.push({ file: relPath, line: index + 1, match: match[0], term });
      }
    }
  }
  return out;
}

const isCli = import.meta.main;
if (isCli) {
  const repoRoot = path.resolve(import.meta.dir, "..");
  const census = process.argv.includes("--census");
  const violations = scan(repoRoot, census);
  if (census) {
    const counts = new Map<RetiredTerm, number>();
    for (const v of violations) counts.set(v.term, (counts.get(v.term) ?? 0) + 1);
    for (const term of RETIRED_TERMS) {
      const count = counts.get(term) ?? 0;
      const status = term.active ? "active " : "pending";
      process.stdout.write(
        `${status} slice ${String(term.slice).padStart(2)} ${String(count).padStart(4)}  ${term.pattern.source}\n`,
      );
    }
    process.exit(0);
  }
  if (violations.length > 0) {
    for (const v of violations) {
      process.stderr.write(
        `terminology: ${v.file}:${v.line} retired '${v.match}' -> ${v.term.replacement} (slice ${v.term.slice})\n`,
      );
    }
    process.exit(1);
  }
}
