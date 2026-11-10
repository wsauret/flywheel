import * as fs from "node:fs";
import * as path from "node:path";
import { isRegisteredDiagnostic, registeredDiagnosticTypes } from "../src/infra/diagnostics-registry.js";
import { PROVIDER_REQUEST_DIAGNOSTIC_TYPES } from "../src/orchestration/session/provider-request-audit-facts.js";

// Every record family that reaches the JSONL diagnostics sink must declare its
// tier in src/infra/diagnostics-registry.ts. Without this gate a new family is
// simply absent from the table, which the sink treats as DEBUG: correct, and
// silent. The author never learns their records are not being written, and the
// reverse mistake - a per-event family declared INFO - is only ever caught by
// a disk filling up. This check makes the omission a build failure and points
// at the one file that decides.
//
// Call rate is not statically knowable, so this gate enforces the declaration,
// not the choice. The sink reports an INFO family that turns out high volume at
// runtime (HIGH_VOLUME_TYPE_RECORDS in debug-log.ts).

const REPO_ROOT = path.resolve(import.meta.dir, "..");

interface Producer {
  readonly file: string;
  readonly what: string;
  readonly pattern: RegExp;
}

// Log's four level records are written by log.ts through the same sink.
const LOG_LEVEL_TYPES = ["log.debug", "log.info", "log.warn", "log.error"];

const PRODUCERS: readonly Producer[] = [
  {
    file: "src/orchestration/app-service/session-auto-delete.ts",
    what: "automatic session deletion decisions and pass outcomes",
    pattern: /DebugLog\.record\(\{\s*type:\s*"([^"]+)"/g,
  },
  {
    file: "src/orchestration/agent-runtime/tools/bash-command-policy.ts",
    what: "static shell write-target refusals",
    pattern: /DebugLog\.record\(\{\s*type:\s*"([^"]+)"/g,
  },
  {
    file: "src/orchestration/agent-runtime/capability-narrowing.ts",
    what: "narrowing statements of tree-hosted agents",
    pattern: /DebugLog\.record\(\{\s*type:\s*"([^"]+)"/g,
  },
  {
    file: "src/orchestration/app-service/project-state-worker.ts",
    what: "state Worker operation queue and service timing",
    pattern: /DebugLog\.record\(\{\s*type:\s*"([^"]+)"/g,
  },
  {
    file: "src/orchestration/session/capacity-wait.ts",
    what: "capacity wait authority changes: armed, re-armed, fired, withdrawn",
    pattern: /DebugLog\.record\(\{\s*type:\s*"([^"]+)"/g,
  },
  {
    file: "src/orchestration/agent-runtime/agent-resilience.ts",
    what: "local persistence refusal terminal decisions",
    pattern: /DebugLog\.record\(\{\s*type:\s*"([^"]+)"/g,
  },
  {
    file: "src/orchestration/agent-runtime/assistant-turn-attempt.ts",
    what: "reasoning repetition trips of one wire attempt",
    pattern: /DebugLog\.record\(\{\s*type:\s*"([^"]+)"/g,
  },
  {
    file: "src/orchestration/agent-runtime/agent-loop-compaction-state.ts",
    what: "automatic compaction deferrals of one fresh context",
    pattern: /DebugLog\.record\(\{\s*type:\s*"([^"]+)"/g,
  },
  {
    file: "src/infra/startup-timeline.ts",
    what: "bounded startup lifecycle summaries",
    pattern: /emit\(\{\s*type:\s*"([^"]+)"/g,
  },
  {
    file: "src/infra/runtime-fact-mapper.ts",
    what: "runtime event debug channel",
    // defineRuntimeEvent({ type: "...", ..., debug: mapX })
    pattern: /defineRuntimeEvent\(\{\s*type:\s*"([^"]+)"[^\n]*\bdebug:\s*\w/g,
  },
  {
    file: "src/infra/llm/model-catalog-resolution.ts",
    what: "dynamic model catalog collision evidence",
    pattern: /DebugLog\.record\(\{\s*type:\s*"([^"]+)"/g,
  },
  {
    file: "src/infra/llm/model-id.ts",
    what: "static model catalog collision evidence",
    pattern: /DebugLog\.record\(\{\s*type:\s*"([^"]+)"/g,
  },
  {
    file: "src/infra/render-probe.ts",
    what: "render phase evidence",
    pattern: /DebugLog\.record\(\{\s*type:\s*"([^"]+)"/g,
  },
  {
    file: "src/infra/conversation-fts.ts",
    what: "derived conversation index write boundary",
    pattern: /DebugLog\.record\(\{\s*type:\s*"([^"]+)"/g,
  },
  {
    file: "src/tui/app.tsx",
    what: "render frame summary",
    pattern: /DebugLog\.record\(\{\s*type:\s*"([^"]+)"/g,
  },
  {
    file: "src/tui/output-window/output-window-scroll-anomalies.ts",
    what: "transcript scroll fights and row mount churn",
    pattern: /"(tui\.(?:scroll\.fight|row\.mount_churn)\.[a-z_]+)"/g,
  },
  {
    file: "src/tui/hooks/create-chat-submissions.ts",
    what: "exceptional terminal submission feedback",
    pattern: /DebugLog\.record\(\{\s*type:\s*"([^"]+)"/g,
  },
  {
    file: "src/orchestration/app-service/account-service.ts",
    what: "account project lifecycle",
    pattern: /DebugLog\.record\(\{\s*type:\s*"([^"]+)"/g,
  },
  {
    file: "src/orchestration/app-service/processor-governor.ts",
    what: "processor admission holds, releases, and failed holds",
    pattern: /"(runtime\.processor_admission\.[a-z_]+)"/g,
  },
  {
    file: "src/orchestration/app-service/worker-background-client.ts",
    what: "background Worker allocation",
    pattern: /DebugLog\.record\(\{\s*type:\s*"([^"]+)"/g,
  },
  {
    file: "src/orchestration/app-service/runtime-maintenance-owner.ts",
    what: "maintenance Worker allocation",
    pattern: /DebugLog\.record\(\{\s*type:\s*"([^"]+)"/g,
  },
  {
    file: "src/orchestration/app-service/definition-root-watcher.ts",
    what: "published definition revisions",
    pattern: /DebugLog\.record\(\{\s*type:\s*"([^"]+)"/g,
  },
  {
    file: "src/orchestration/app-service/runtime-protocol-handlers.ts",
    what: "client lane attach timing",
    pattern: /DebugLog\.record\(\{\s*type:\s*"([^"]+)"/g,
  },
  {
    file: "src/orchestration/app-service/socket-runtime-client.ts",
    what: "client socket target and event lane admission",
    pattern: /DebugLog\.record\(\{\s*type:\s*"([^"]+)"/g,
  },
  {
    file: "src/orchestration/modules/code-mode/worker-pool.ts",
    what: "Code Mode Worker allocation and retirement",
    pattern: /DebugLog\.record\(\{\s*type:\s*"([^"]+)"/g,
  },
  {
    file: "src/orchestration/session/session-summary-index.ts",
    what: "session summary replay page",
    pattern: /DebugLog\.record\(\{\s*type:\s*"([^"]+)"/g,
  },
  {
    file: "src/orchestration/session/session-messaging.ts",
    what: "duplicate session message refusal",
    pattern: /DebugLog\.record\(\{\s*type:\s*"([^"]+)"/g,
  },
  {
    file: "src/orchestration/agent-runtime/prompt-prefix-hold.ts",
    what: "prompt prefix hold settlement",
    pattern: /DebugLog\.record\(\{\s*type:\s*"([^"]+)"/g,
  },
  {
    file: "src/orchestration/modules/provider-claude-agent-sdk/agent-host/host.ts",
    what: "shared agent host closes, dispatch frames, refused steps, stopped tasks, dispatch faults, plugin reloads, and refused cuts",
    pattern: /DebugLog\.record\(\{\s*type:\s*"([^"]+)"/g,
  },
  {
    file: "src/orchestration/modules/provider-claude-agent-sdk/observed-engine.ts",
    what: "Claude engine launches, chat and host",
    pattern: /DebugLog\.record\(\{\s*type:\s*"([^"]+)"/g,
  },
  {
    file: "src/orchestration/modules/provider-claude-agent-sdk/agent-host/agent-bridge.ts",
    what: "hosted agent dispatches, ends, and failures",
    pattern: /DebugLog\.record\(\{\s*type:\s*"([^"]+)"/g,
  },
  {
    file: "src/orchestration/modules/provider-claude-agent-sdk/agent-host/host-registry.ts",
    what: "a chat tree's second agent host and the place fields that split it",
    pattern: /DebugLog\.record\(\{\s*type:\s*"([^"]+)"/g,
  },
  {
    file: "src/orchestration/modules/provider-claude-agent-sdk/agent-host/hosted-requests.ts",
    what: "hosted agents' hidden requests and unattributed stream errors",
    pattern: /DebugLog\.record\(\{\s*type:\s*"([^"]+)"/g,
  },
  {
    file: "src/orchestration/modules/provider-claude-agent-sdk/agent-host/host-gate.ts",
    what: "agent host gate requests that the gate cannot read",
    pattern: /DebugLog\.record\(\{\s*type:\s*"([^"]+)"/g,
  },
  {
    file: "src/orchestration/modules/provider-claude-agent-sdk/bridge.ts",
    what: "Claude Agent SDK bridge query lifecycle",
    pattern: /DebugLog\.record\(\{\s*type:\s*"([^"]+)"/g,
  },
  {
    file: "src/orchestration/modules/provider-claude-agent-sdk/transcript.ts",
    what: "Claude engine artifacts that a sweep reclaimed",
    pattern: /DebugLog\.record\(\{\s*type:\s*"([^"]+)"/g,
  },
  {
    file: "src/orchestration/modules/provider-claude-agent-sdk/bridge-reservation.ts",
    what: "Claude Agent SDK engine reservations and their ends",
    pattern: /DebugLog\.record\(\{\s*type:\s*"([^"]+)"/g,
  },
  {
    file: "src/orchestration/modules/provider-claude-agent-sdk/login-observations.ts",
    what: "external account login condition decisions",
    pattern: /DebugLog\.record\(\{\s*type:\s*"([^"]+)"/g,
  },
  {
    file: "src/orchestration/modules/provider-claude-agent-sdk/cli-login.ts",
    what: "duplicate Claude login locations retired by a login again",
    pattern: /DebugLog\.record\(\{\s*type:\s*"([^"]+)"/g,
  },
  {
    file: "src/orchestration/modules/provider-claude-agent-sdk/query-launcher.ts",
    what: "Claude Agent SDK model listing CLI stops",
    pattern: /DebugLog\.record\(\{\s*type:\s*"([^"]+)"/g,
  },
  {
    file: "src/orchestration/modules/provider-claude-agent-sdk/in-place-check.ts",
    what: "Claude Agent SDK in-place rotation checks",
    pattern: /DebugLog\.record\(\{\s*type:\s*"([^"]+)"/g,
  },
  {
    file: "src/orchestration/modules/provider-claude-agent-sdk/stderr-signals.ts",
    what: "Claude Agent SDK silent CLI debug output",
    pattern: /DebugLog\.record\(\{\s*type:\s*"([^"]+)"/g,
  },
  {
    file: "src/orchestration/modules/provider-claude-agent-sdk/service-requests.ts",
    what: "Claude Agent SDK service requests in the engine debug output",
    pattern: /DebugLog\.record\(\{\s*type:\s*"([^"]+)"/g,
  },
  {
    file: "src/orchestration/modules/provider-claude-agent-sdk/extra-usage-guard.ts",
    what: "Claude Agent SDK usage reports",
    pattern: /DebugLog\.record\(\{\s*type:\s*"([^"]+)"/g,
  },
  {
    file: "src/orchestration/modules/provider-claude-agent-sdk/step-gate.ts",
    what: "Claude Agent SDK step gate requests that the gate cannot read",
    pattern: /DebugLog\.record\(\{\s*type:\s*"([^"]+)"/g,
  },
  {
    file: "src/workflows/vm/host-commit-controller.ts",
    what: "workflow request addendum commits",
    pattern: /DebugLog\.record\(\{\s*type:\s*"([^"]+)"/g,
  },
  {
    file: "src/workflows/vm/host.ts",
    what: "workflow attempt admission batches",
    pattern: /DebugLog\.record\(\{\s*type:\s*"([^"]+)"/g,
  },
  {
    file: "src/orchestration/workflow-host/path-workflow.ts",
    what: "workflow files saved from launch content",
    pattern: /DebugLog\.record\(\{\s*type:\s*"([^"]+)"/g,
  },
  {
    file: "src/orchestration/agent-runtime/unattended-recovery.ts",
    what: "recovery decisions of an unattended run",
    pattern: /DebugLog\.record\(\{\s*type:\s*"([^"]+)"/g,
  },
  {
    file: "src/infra/llm/model-listing.ts",
    what: "saved model refusals",
    pattern: /DebugLog\.record\(\{\s*type:\s*"([^"]+)"/g,
  },
  {
    file: "src/orchestration/agent-runtime/tools/bash-project-mutation.ts",
    what: "bash mutation command publication",
    pattern: /DebugLog\.record\(\{\s*type:\s*"([^"]+)"/g,
  },
  {
    file: "src/orchestration/app-service/session-runtime-actor.ts",
    what: "refused question settlements",
    pattern: /DebugLog\.record\(\{\s*type:\s*"([^"]+)"/g,
  },
];

function readFile(relative: string): string {
  const full = path.join(REPO_ROOT, relative);
  if (!fs.existsSync(full)) {
    throw new Error(`diagnostics registry check: producer file is missing: ${relative}`);
  }
  return fs.readFileSync(full, "utf8");
}

function producedTypes(): Map<string, string> {
  const produced = new Map<string, string>();
  for (const type of LOG_LEVEL_TYPES) produced.set(type, "Log level record");
  for (const type of PROVIDER_REQUEST_DIAGNOSTIC_TYPES) produced.set(type, "provider request raw stream telemetry");
  for (const producer of PRODUCERS) {
    const source = readFile(producer.file);
    for (const match of source.matchAll(producer.pattern)) {
      const type = match[1];
      if (type !== undefined) produced.set(type, `${producer.what} (${producer.file})`);
    }
  }
  return produced;
}

function main(): void {
  const produced = producedTypes();
  const problems: string[] = [];

  for (const [type, origin] of produced) {
    if (!isRegisteredDiagnostic(type)) {
      problems.push(
        `  ${type}\n    written by ${origin}\n    but absent from src/infra/diagnostics-registry.ts, so the sink drops it as an undeclared family.`,
      );
    }
  }

  for (const type of registeredDiagnosticTypes()) {
    if (!produced.has(type)) {
      problems.push(
        `  ${type}\n    declared in src/infra/diagnostics-registry.ts\n    but no producer writes it. Remove the entry so the table stays an account of the real stream.`,
      );
    }
  }

  if (problems.length === 0) {
    console.log(`diagnostics: ${produced.size} record type(s) declared`);
    return;
  }

  console.error("diagnostics registry is out of date:\n");
  console.error(problems.join("\n\n"));
  console.error(
    "\nDeclare each record type with the tier it deserves. INFO is for per-request, per-turn, and",
  );
  console.error(
    "per-session-lifecycle families. A family that records per stream event, per token, per read,",
  );
  console.error("or per store change is DEBUG.");
  process.exit(1);
}

main();
