import { describe, expect, setSystemTime, test } from "bun:test";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Effect, Exit, Redacted, Scope } from "effect";
import { answers, init, launchFakeQuery, settle, turnDone, until, type FakeQuery } from "./_bridge-harness.js";
import { localDateZone } from "../../../../../src/infra/env-detection.js";
import type { LauncherScope } from "../../../../../src/infra/process-supervisor.js";
import { providerModelInfo } from "../../../../../src/infra/llm/provider-model-info.js";
import { createClaudeReminders } from "../../../../../src/orchestration/agent-runtime/llm/claude-reminders.js";
import type { AccessProviderBuild } from "../../../../../src/orchestration/agent-runtime/llm/client-factory.js";
import type { ConversationMessage } from "../../../../../src/orchestration/agent-runtime/llm/types.js";
import { createClaudeAgentSdkClient } from "../../../../../src/orchestration/modules/provider-claude-agent-sdk/client.js";
import { enginePath } from "../../../../../src/infra/claude-engine.js";
import type { QueryLaunch, QueryLauncherConfig } from "../../../../../src/orchestration/modules/provider-claude-agent-sdk/query-launcher.js";
import { fakeAvailability } from "../../agent-runtime/llm/_provider-chain-harness.js";
import { temporaryDirectories } from "../../../../helpers/directories.js";
import { SHELL_CAPABILITIES } from "../../../../helpers/prompt-capabilities.js";

const temporaryDirectory = temporaryDirectories();

const MODEL = "claude-sonnet-5-5";

const noLaunch: LauncherScope = {
  spawnOwned: () => Promise.reject(new Error("no launch in a unit test")),
  adoptOwned: () => Promise.reject(new Error("no adoption in a unit test")),
  open: () => noLaunch,
  close: async () => ({ settled: true }),
};

/** A build whose login lives in `configDir`. A request takes a session lock there, so a test that sends one gives a real
 *  directory. Without `lifetime` the client's scope never closes, so a test that starts a bridge passes its own. */
function build(options: { readonly launcher?: LauncherScope; readonly lifetime?: Scope.Scope; readonly spendMode?: "included" | "automatic"; readonly configDir?: string } = {}): AccessProviderBuild {
  const candidate = { kind: "subscription", providerId: "claude_agent_sdk", instanceId: "login", spendMode: options.spendMode ?? "included" } as const;
  const credential = { type: "external", configDir: options.configDir ?? "/scratch/claude-config" } as const;
  const metadata = providerModelInfo({ provider: "anthropic", id: MODEL, contextLimit: 1_000_000, outputLimit: 64_000, reasoning: true });
  return {
    notify: () => {},
    candidate, providerIdentity: { name: "Anthropic Sub", credential: "oauth" },
    model: metadata.id, wireModelId: metadata.id, family: "anthropic",
    modelsClient: { async refresh() {}, getProviderCatalog: () => [], getTokenizerIdentity: () => undefined },
    connection: {
      id: "connection", authDir: "/scratch/auth", oauthPersistence: "memory-only",
      auth: { providers: new Map(), credentialLineages: {}, droppedCredentials: [] },
      subscriptionCredentials: new Map([[candidate.providerId, [{ instanceId: candidate.instanceId, identity: "person@example.com", lineageId: candidate.instanceId, credential }]]]),
    },
    classifySlot: () => "subscription", availability: fakeAvailability({}).availability, projectRoot: "/scratch/project",
    attribution: { candidate, wireModelId: metadata.id, dataUse: "standard", resolvedModelMetadata: metadata },
    recordModelRefusal: () => {},
    accountOfferings: () => [],
    ...(options.launcher === undefined ? {} : { launcher: options.launcher }),
    providerSessionLifetime: { providerSessionKey: "conversation", scope: options.lifetime ?? Scope.makeUnsafe() },
  };
}

/** Records every launcher the client builds and every query it starts, and fails the start, so no request
 *  needs a CLI. */
function recordingLaunches() {
  const configs: QueryLauncherConfig[] = [];
  const launches: QueryLaunch[] = [];
  return {
    configs, launches,
    seams: {
      enginePath: "/scratch/bin/claude",
      cliEnvironment: { ANTHROPIC_BASE_URL: "http://127.0.0.1:1" },
      createLauncher: (config: QueryLauncherConfig) => {
        configs.push(config);
        return (launch: QueryLaunch): never => {
          launches.push(launch);
          throw new Error("no CLI in a unit test");
        };
      },
    },
  };
}

/** Reads a stream to its end and returns the error that ended it, if any. */
async function streamFailure(stream: AsyncIterable<unknown>): Promise<Error | undefined> {
  try {
    for await (const _event of stream) { /* drained */ }
    return undefined;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
}

describe("the Agent SDK bridge client", () => {
  test("connecting without the generation's launcher fails with a typed error and builds no launcher", async () => {
    const recorded = recordingLaunches();
    const staged = await createClaudeAgentSdkClient(build(), recorded.seams);

    await expect(staged.connect()).rejects.toMatchObject({ _tag: "ApiError", message: expect.stringContaining("launch authority") });
    expect(recorded.configs).toEqual([]);
  });

  test("connecting runs the engine that ships with Flywheel, never a claude on the PATH, and the engine inherits this process's PATH", async () => {
    const pathBin = temporaryDirectory("claude-sdk-path-");
    writeFileSync(join(pathBin, "claude"), "#!/bin/sh\n");
    chmodSync(join(pathBin, "claude"), 0o755);
    const { enginePath: _named, ...seams } = recordingLaunches().seams;
    const configs: QueryLauncherConfig[] = [];
    const previous = process.env.PATH;
    const lifetime = Effect.runSync(Scope.make());
    process.env.PATH = `${pathBin}:${previous ?? ""}`;
    try {
      const staged = await createClaudeAgentSdkClient(build({ launcher: noLaunch, lifetime }), {
        ...seams,
        createLauncher: (config) => { configs.push(config); return () => { throw new Error("no CLI in a unit test"); }; },
      });
      await staged.connect();
    } finally {
      process.env.PATH = previous;
      await Effect.runPromise(Scope.close(lifetime, Exit.void));
    }
    expect(configs.map((config) => config.enginePath)).toEqual([enginePath()]);
    // The engine reads this process's environment, PATH included, when it starts.
    expect(configs[0]?.hostEnvironment).toBe(process.env);
    // The engine's dates use the zone of Flywheel's own dates.
    expect(configs[0]?.timeZone).toBe(localDateZone());
  });

  test("connecting as an OS user that the account database does not name hands the request on, and names the cause", async () => {
    const recorded = recordingLaunches();
    const staged = await createClaudeAgentSdkClient(build({ launcher: noLaunch }), {
      ...recorded.seams,
      account: () => { throw new Error("The account database has no entry for user id 1234"); },
    });

    await expect(staged.connect()).rejects.toMatchObject({ failure: { _tag: "RouteUnavailableFailure", message: expect.stringContaining("no entry for user id 1234") } });
    expect(recorded.configs).toEqual([]);
  });

  test("canonical history carries the shared reminders, and a request starts the engine on the config directory of the account's login", async () => {
    const lifetime = Effect.runSync(Scope.make());
    const recorded = recordingLaunches();
    const configDir = temporaryDirectory("claude-config-");
    const staged = await createClaudeAgentSdkClient(build({ launcher: noLaunch, lifetime, configDir }), recorded.seams);
    const history: ConversationMessage[] = [{ kind: "user", origin: "human", content: "Read a." }];
    // Both sides read the local date, so a fixed clock keeps them on one day.
    setSystemTime(new Date("2026-10-07T12:00:00"));
    try {
      expect(staged.attempt.messagesToAppend?.(history, "/scratch/project", SHELL_CAPABILITIES)).toEqual(createClaudeReminders(MODEL, 1_000_000)(history, "/scratch/project", SHELL_CAPABILITIES));
    } finally {
      setSystemTime();
    }

    const client = await staged.connect();
    const failure = await streamFailure(client.streamWithTools({
      messages: history,
      tools: [{ name: "read", description: "Reads a file.", input_schema: { type: "object", properties: { path: { type: "string" } } } }],
      systemPrompt: { stable: "Stable prompt.", session: "Session tail.", conversation: "" },
      reasoningEffort: "medium",
    }));
    await Effect.runPromise(Scope.close(lifetime, Exit.void));

    expect(failure).toBeDefined();
    expect(recorded.configs).toMatchObject([{ enginePath: "/scratch/bin/claude", configDir, launcher: noLaunch, cliEnvironment: { ANTHROPIC_BASE_URL: "http://127.0.0.1:1" } }]);
    // The CLI adds its own system prefix and tool prefix, so the query holds the canonical prompt tiers and
    // Flywheel's tool names.
    expect(recorded.launches).toMatchObject([{ systemPrompt: ["Stable prompt.", "Session tail."], tools: [{ name: "read", description: "Reads a file." }], cwd: "/scratch/project", wireModelId: MODEL, contextLimit: 1_000_000 }]);
  });

  test.each([
    ["a token login, whose config names no account, keeps serving after its first included response", true, []],
    ["a login whose config names no account stops at its first response, because nothing confirms included usage", false, ["raise"]],
  ])("%s", async (_name, tokenLogin, notices) => {
    const lifetime = Effect.runSync(Scope.make());
    const configDir = temporaryDirectory("claude-token-config-");
    const raised: string[] = [];
    const queries: FakeQuery[] = [];
    const base = build({ launcher: noLaunch, lifetime, configDir });
    const credential = { type: "external", configDir, ...(tokenLogin ? { token: Redacted.make("token-login") } : {}) } as const;
    const staged = await createClaudeAgentSdkClient({
      ...base, notify: (notice) => { raised.push(notice.type); },
      connection: { ...base.connection, subscriptionCredentials: new Map([["claude_agent_sdk", [{ instanceId: "login", identity: "token login", lineageId: "login", credential }]]]) },
    }, {
      ...recordingLaunches().seams, inPlaceGate: () => ({ status: () => Effect.succeed("unlisted") }),
      createLauncher: () => (launch) => { const { query, launched } = launchFakeQuery(launch, [], "auto"); queries.push(query); return launched; },
    });
    const client = await staged.connect();
    const reply = (async () => { for await (const _event of client.streamWithTools({ messages: [{ kind: "user", origin: "human", content: "Read a." }], tools: [], systemPrompt: { stable: "Stable prompt.", session: "", conversation: "" } })) { /* drained */ } })();
    await until(() => queries.length === 1);
    queries[0]?.emit(init, ...answers("Done."), turnDone);
    await reply;
    await settle();
    await Effect.runPromise(Scope.close(lifetime, Exit.void));

    expect(raised).toEqual(notices);
  });

  test("a tool name the model invents under the MCP prefix returns to Flywheel's name space", async () => {
    const { toolPresentation } = (await createClaudeAgentSdkClient(build(), recordingLaunches().seams)).attempt;
    expect(toolPresentation.canonicalName?.(toolPresentation.wireName?.("note_append") ?? "")).toBe("note_append");
    expect(toolPresentation.canonicalName?.("mcp__runtime__note_edit_placeholder")).toBe("note_edit_placeholder");
    expect(toolPresentation.canonicalName?.("mcp__runtime__mcp__runtime__ask_user")).toBe("ask_user");
  });

  test("each client that shares a conversation key keeps its own bridge and CLI session, which its later queries reuse", async () => {
    // A rebuilt client and a learning review share the conversation's key. Their CLIs run side by side, so a
    // shared session id would let one rotation transcript overwrite or delete the other's.
    const lifetime = Effect.runSync(Scope.make());
    const recorded = recordingLaunches();
    const configDir = temporaryDirectory("claude-config-");
    const first = await (await createClaudeAgentSdkClient(build({ launcher: noLaunch, lifetime, configDir }), recorded.seams)).connect();
    const second = await (await createClaudeAgentSdkClient(build({ launcher: noLaunch, lifetime, configDir }), recorded.seams)).connect();
    const request = { messages: [{ kind: "user", origin: "human", content: "Read a." }] satisfies ConversationMessage[], tools: [], systemPrompt: { stable: "Stable prompt.", session: "", conversation: "" } };

    const failures = [await streamFailure(first.streamWithTools(request)), await streamFailure(second.streamWithTools(request)), await streamFailure(first.streamWithTools(request))];
    await Effect.runPromise(Scope.close(lifetime, Exit.void));

    expect(failures.map((failure) => failure?.message)).toEqual(Array.from({ length: 3 }, () => expect.stringContaining("no CLI in a unit test")));
    const [firstId, secondId, firstAgain] = recorded.launches.map(({ session }) => session.id);
    expect(recorded.launches).toHaveLength(3);
    expect(firstId).not.toBe(secondId);
    expect(firstAgain).toBe(firstId);
  });

  test("the included and the paid client of one lifetime, login, and model keep separate bridges and CLI sessions", async () => {
    const lifetime = Effect.runSync(Scope.make());
    const recorded = recordingLaunches();
    const configDir = temporaryDirectory("claude-config-");
    const included = await (await createClaudeAgentSdkClient(build({ launcher: noLaunch, lifetime, configDir }), recorded.seams)).connect();
    const paid = await (await createClaudeAgentSdkClient(build({ launcher: noLaunch, lifetime, spendMode: "automatic", configDir }), recorded.seams)).connect();
    const request = { messages: [{ kind: "user", origin: "human", content: "Read a." }] satisfies ConversationMessage[], tools: [], systemPrompt: { stable: "Stable prompt.", session: "", conversation: "" } };

    const failures = [await streamFailure(included.streamWithTools(request)), await streamFailure(paid.streamWithTools(request))];
    await Effect.runPromise(Scope.close(lifetime, Exit.void));

    expect(failures.map((failure) => failure?.message)).toEqual([expect.stringContaining("no CLI in a unit test"), expect.stringContaining("no CLI in a unit test")]);
    const [first, second] = recorded.launches.map(({ session }) => session.id);
    expect(recorded.launches).toHaveLength(2);
    expect(first).not.toBe(second);
  });
});
