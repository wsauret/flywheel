import { expect, test } from "bun:test";
import { testProviderSessionLifetime } from "../../../helpers/provider-authority.js";

import { canonicalPathWithMissingTail } from "../../../../src/infra/canonical-path.js";
import { createLauncherScope } from "../../../../src/infra/process-supervisor.js";
import { accountAuthDir } from "../../../../src/infra/paths.js";
import { createBackgroundExecutionOwner } from "../../../../src/orchestration/agent-runtime/background-execution-owner.js";
import { createBackgroundWorkRegistry } from "../../../../src/orchestration/agent-runtime/background-work.js";
import { createForegroundBashHoldController } from "../../../../src/orchestration/agent-runtime/foreground-bash-hold.js";
import { assembleRuntimeForTurn } from "../../../../src/orchestration/agent-runtime/runtime-assembly.js";
import { resolveRuntimeConversation } from "../../../../src/orchestration/agent-runtime/runtime-conversation.js";
import type { ProviderStreamEvent } from "../../../../src/orchestration/agent-runtime/llm/types.js";
import { completeRuntimeToolSurfaces } from "../../../../src/orchestration/agent-runtime/factory.js";
import { deriveChildRuntimeSurfaces } from "../../../../src/orchestration/agent-runtime/tools/tool-registry.js";
import type { CaptureRuntimeConfig } from "../../../../src/orchestration/agent-runtime/request-config.js";
import type { RuntimeToolSurfaces } from "../../../../src/orchestration/agent-runtime/types.js";
import { repoDefinitions } from "../../../helpers/project-definitions.js";
import { temporaryDirectories, testDirectories } from "../../../helpers/directories.js";
import { asModelClient } from "./_model-client.js";
import { makeMockOwnedProcess, ownedSpawnProbe, streamOf } from "./tools/_bash-fixtures.js";
import { makeContext } from "./tools/_fixtures.js";
import { testCapabilityModules, testRuntimeConfigCapture } from "../../../helpers/request-tool-surface.js";

const temporaryDirectory = temporaryDirectories();

const attempt = {
  accessProvider: "anthropic_api" as const,
  modelFamily: "anthropic" as const,
  model: "test",
  contextLimit: 100_000,
  outputLimit: 8_000,
  supportsReasoning: false,
  promptNotes: { progress: "", modelNotes: "" },
  priceFor: () => ({ status: "unavailable", reason: "missing-rate-card" } as const),
  async *streamWithTools(): AsyncGenerator<ProviderStreamEvent> {
    yield { kind: "done", stopReason: "end_turn" };
  },
  complete: async () => "",
};

/** Assembles one runtime turn over `surfaces` and `captureRuntimeConfig`, and
 *  returns what it planned and the Bash tool of its first request. */
async function assembleBash(options: {
  readonly surfaces?: (surfaces: RuntimeToolSurfaces) => RuntimeToolSurfaces;
  readonly captureRuntimeConfig?: CaptureRuntimeConfig;
} = {}) {
  let providerPlanned = false;
  const signal = new AbortController().signal;
  const background = createBackgroundExecutionOwner(createBackgroundWorkRegistry({ kind: "chat", enqueueNotification() {} }));
  const foregroundBashHold = createForegroundBashHoldController(() => {});
  const client = asModelClient(attempt);
  const directories = testDirectories(process.cwd());
  const spawn = ownedSpawnProbe(() => makeMockOwnedProcess({ stdout: streamOf("ready\n") }));
  const surfaces = completeRuntimeToolSurfaces(
    { background, foregroundBashHold },
    { launcher: createLauncherScope({ spawnOwned: spawn.spawnOwned, adoptOwned: () => Promise.reject(new Error("no command is adopted here")) }) },
  );
  const assembled = await assembleRuntimeForTurn({
    providerSessionLifetime: testProviderSessionLifetime(),
    options: {
      model: "test",
      ...directories,
      purpose: { kind: "interactive-chat" },
      agentsMd: "",
      onEvent: () => {},
      moduleSelection: testCapabilityModules,
      awaitModelAccessSettled: async () => {}, captureRuntimeConfig: options.captureRuntimeConfig ?? testRuntimeConfigCapture,
      conversation: { kind: "stateless" },
      lifecycle: { kind: "one-shot" },
      runtimeSurfaces: options.surfaces?.(surfaces) ?? surfaces,
    },
    definitions: repoDefinitions(),
    conversation: resolveRuntimeConversation({ kind: "stateless" }, {
      providerSessionKey: "conversation-b1-readiness",
      artifactScopeId: "artifacts-b1-readiness",
      retrievalSessionId: "retrieval-b1-readiness",
    }),
    signal,
    disposalSignal: signal,
    instruction: null,
    currentTurn: undefined,
    personas: new Map(),
    captureModelRuntime: async () => ({
      generation: {},
      createLLMClient: async () => ({
        ...client,
        admitRequest: async () => {
          providerPlanned = true;
          return client.admitRequest();
        },
      }),
    }),
    createRunner: () => { throw new Error("unused in this test"); },
  });
  if (!("resolve" in assembled.tools)) throw new Error("expected request tool surface owner");
  const requestSurface = await assembled.tools.resolve();
  const bash = requestSurface.tools.get("bash");
  if (!bash) throw new Error("expected native Bash tool");
  return {
    assembled, requestSurface, bash, spawn, directories, providerPlanned,
    async dispose() {
      await background.close();
      foregroundBashHold.dispose();
    },
  };
}

test("ordinary runtime plans the provider and dispatches native Bash", async () => {
  const { assembled, requestSurface, bash, spawn, directories, providerPlanned, dispose } = await assembleBash();

  expect(providerPlanned).toBe(true);
  expect(assembled.protectedTraversalRoots).toEqual([
    canonicalPathWithMissingTail(accountAuthDir(directories.userDataRoot)),
  ]);

  const result = await bash.execute(
    { command: "printf ready" },
    // A slow machine can yield the command to the background, which writes its
    // script and log into the scratch directory.
    makeContext({ availableTools: new Set(requestSurface.tools.keys()), spawnOwned: spawn.spawnOwned, scratchDir: temporaryDirectory("flywheel-bash-readiness-") }),
  );

  expect(result.outcome).toBe("ok");
  expect(spawn.launches).toHaveLength(1);
  await dispose();
});

test("a headless runtime's child offers Bash without mutates, and the write guard setting decides the write-roots sentence", async () => {
  const writeRoots = "Keep writes inside the project, the .flywheel folders, and registered worktrees";
  const interactive = await assembleBash();
  expect(interactive.bash.inputSchema.properties).toHaveProperty("mutates");
  expect(interactive.bash.description).toContain(writeRoots);
  await interactive.dispose();

  const headlessChild = await assembleBash({ surfaces: (surfaces) => deriveChildRuntimeSurfaces(completeRuntimeToolSurfaces(surfaces, { headless: true })) });
  expect(headlessChild.bash.inputSchema.properties).not.toHaveProperty("mutates");
  expect(headlessChild.bash.description).not.toMatch(/mutat/);
  await headlessChild.dispose();

  const unguarded = await assembleBash({ captureRuntimeConfig: () => ({ ...testRuntimeConfigCapture(), shellWriteGuard: false }) });
  expect(unguarded.bash.description).not.toContain(writeRoots);
  expect(unguarded.bash.inputSchema).toEqual(interactive.bash.inputSchema);
  await unguarded.dispose();
});
