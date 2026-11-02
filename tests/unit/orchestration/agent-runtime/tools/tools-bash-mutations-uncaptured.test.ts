import { afterEach, beforeAll, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { DebugLog } from "../../../../../src/infra/debug-log.js";
import { createBashDefinition } from "../../../../../src/orchestration/agent-runtime/tools/bash.js";
import { loadBashParser } from "../../../../../src/orchestration/agent-runtime/tools/bash-parser.js";
import * as mutationGuard from "../../../../../src/orchestration/agent-runtime/tools/bash-mutation-guard.js";
import { privateCopyRemovals } from "../../../../../src/orchestration/agent-runtime/tools/bash-private-copy.js";
import { temporaryDirectories } from "../../../../helpers/directories.js";
import { mutationSpawnProbe, makeMockOps } from "./_bash-fixtures.js";
import { capabilityAccessHolding, createRecordingFileMutationStore, makeContext } from "./_fixtures.js";
import { bashMutationHarness } from "./_bash-mutations-harness.js";
import { PersistenceWriteRefused } from "../../../../../src/infra/event-store-types.js";
import { runAgentTurn } from "../../../../../src/orchestration/runner/agent-turn.js";
import { createBackgroundWorkRegistry } from "../../../../../src/orchestration/agent-runtime/background-work.js";
import { createForegroundBashHoldController } from "../../../../../src/orchestration/agent-runtime/foreground-bash-hold.js";

const createDirectory = temporaryDirectories();

beforeAll(async () => {
  await loadBashParser();
});

describe("bash tool: mutation capture failures", () => {
  afterEach(privateCopyRemovals);
  const { project, runMutation } = bashMutationHarness(createDirectory);

  it("keeps the wrapper outside captured-copy cleanup", async () => {
    const root = project([["a.txt", "old\n"]]);
    const { result, launches } = await runMutation(root, (cwd) => {
      fs.writeFileSync(path.join(cwd, "a.txt"), "new\n");
    });
    expect(result.outcome).toBe("ok");
    const launch = launches.find((entry) => entry.cwd !== undefined);
    expect(launch?.cwd).not.toBe(root);
    const env = launch?.env ?? {};
    const pathKey = process.platform === "win32" ? Object.keys(env).find((key) => key.toUpperCase() === "PATH") ?? "PATH" : "PATH";
    const wrapper = env[pathKey]?.split(path.delimiter)[0] ?? "";
    await privateCopyRemovals();
    expect(fs.existsSync(launch?.cwd ?? "")).toBe(false);
    expect(fs.existsSync(path.join(wrapper, process.platform === "win32" ? "git.exe" : "git"))).toBe(true);
    expect(fs.readFileSync(path.join(root, "a.txt"), "utf8")).toBe("new\n");
  });

  it.each([
    ["foreground", "preparation"], ["foreground", "publication"],
    ["held", "preparation"], ["held", "publication"],
  ] as const)("ends a %s turn on a %s refusal without losing the changed copy or continuing", async (mode, stage) => {
    const root = project([["a.txt", "old\n"]]);
    const store = createRecordingFileMutationStore();
    const error = new PersistenceWriteRefused(129, 128);
    const messages: string[] = [];
    const continuations: string[] = [];
    const registry = createBackgroundWorkRegistry({ kind: "chat", enqueueNotification: () => { continuations.push("notification"); } });
    const writer = {
      ...store.writer,
      ...(stage === "preparation"
        ? { swapInFlight: async () => { throw error; } }
        : { transaction: async (work: () => void) => { work(); throw error; } }),
    };
    let changedCopy = "";
    try {
      const turn = await runAgentTurn({
        message: "work",
        createContext: () => ({
          send() {}, abort() {}, end() {},
          done: (async () => {
            await runMutation(root, (cwd) => {
              changedCopy = cwd;
              fs.writeFileSync(path.join(cwd, "a.txt"), "new\n");
            }, {}, {
              sessionEventWriter: writer,
              ...(mode === "held" ? { backgroundTasks: registry, capabilityAccess: capabilityAccessHolding(["background-commands"]), foregroundBashHold: createForegroundBashHoldController(() => {}) } : {}),
            });
            continuations.push("next tool or model request");
            return { servedRequests: 0, durationMs: 0, terminal: { kind: "completed" as const } };
          })(),
        }),
        resilience: { pushSystemMessage: (message) => messages.push(message), recover: async () => { continuations.push("recovery"); return null; } },
      });
      expect(turn.terminal).toEqual({ kind: "local_persistence_error", error });
      expect(continuations).toEqual([]);
      expect(messages).toEqual([`Local persistence limit exceeded. Flywheel could not save this operation: its encoded request is 129 bytes; the limit is 128 bytes. ${stage === "preparation" ? "No file changes were applied." : "A file change may already be applied. Its durable settlement is unresolved; Flywheel will inspect it during recovery."}`]);
      expect(fs.readFileSync(path.join(root, "a.txt"), "utf8")).toBe(stage === "preparation" ? "old\n" : "new\n");
      await privateCopyRemovals();
      expect(fs.existsSync(changedCopy)).toBe(stage === "publication");
    } finally {
      await registry.terminateAll();
    }
  });

  it.each((["foreground", "held", "background"] as const).flatMap((mode) =>
    (process.platform === "win32" ? [false] : [false, true]).map((unavailable) => [mode, unavailable] as const),
  ))("guards uncaptured %s commands and counts the miss (guard unavailable: %s)", async (mode, unavailable) => {
    const root = fs.realpathSync(createDirectory("agent-bash-mutations-uncaptured-"));
    fs.writeFileSync(path.join(root, "a.txt"), "a\n");
    // The fake Git answers 128 to every read, which below a .git entry is a refusal, so no copy can be taken.
    fs.mkdirSync(path.join(root, ".git"));
    const scratchDir = path.join(root, ".flywheel", "scratch");
    const store = createRecordingFileMutationStore();
    const spawn = mutationSpawnProbe((cwd) => fs.writeFileSync(path.join(cwd, "a.txt"), "mine\n"));
    const record = spyOn(DebugLog, "record");
    const guard = unavailable ? spyOn(mutationGuard, "hostMutationGuard").mockResolvedValue({ kind: "none", pidNamespace: false }) : undefined;
    const registry = createBackgroundWorkRegistry({ kind: "chat", enqueueNotification() {} });
    try {
      const result = await createBashDefinition({ operations: makeMockOps({ ensureDir: (dir) => { fs.mkdirSync(dir, { recursive: true }); } }) })
        .execute({ command: "reshape", mutates: true, background: mode === "background" }, makeContext({
          projectRoot: root, executionCwd: root, scratchDir, spawnOwned: spawn.spawnOwned, toolUseId: "bash-1", sessionEventWriter: store.writer,
          capabilityAccess: capabilityAccessHolding(["background-commands"]),
          ...(mode !== "foreground" ? { backgroundTasks: registry } : {}),
          ...(mode === "held" ? { foregroundBashHold: createForegroundBashHoldController(() => {}) } : {}),
        }));

      // The host's guard probe can launch first and names no directory; the command ran in the project.
      expect(spawn.launches.filter((launch) => launch.cwd !== undefined).map((launch) => launch.cwd)).toEqual([root]);
      expect(fs.readFileSync(path.join(root, "a.txt"), "utf8")).toBe("mine\n");
      const launch = spawn.launches.find((entry) => entry.cwd === root);
      const env = launch?.env ?? {};
      const pathKey = process.platform === "win32" ? Object.keys(env).find((key) => key.toUpperCase() === "PATH") ?? "PATH" : "PATH";
      const wrapper = env[pathKey]?.split(path.delimiter)[0] ?? "";
      expect(fs.existsSync(path.join(wrapper, process.platform === "win32" ? "git.exe" : "git"))).toBe(true);
      expect(path.isAbsolute(env.FLYWHEEL_MUTATION_GIT_REAL ?? "")).toBe(true);
      expect(env.FLYWHEEL_MUTATION_GIT_RUNTIME).toBe(process.execPath);
      expect(result.content).toStartWith(`Flywheel could not take a private copy of the project (${unavailable ? "the host's mutation guard is unavailable" : "git rev-parse exited with 128 below a .git entry"}`);
      expect(result.content).toContain("its file changes were not recorded as mutations");
      expect(store.facts.filter((fact) => fact.type === "file.changed")).toEqual([]);
      expect(record.mock.calls.map(([input]) => input).filter((input) => input.type === "agent.bash.mutation.uncaptured")).toEqual([
        expect.objectContaining({ payload: expect.objectContaining({ toolUseId: "bash-1" }) }),
      ]);
      await privateCopyRemovals();
      const mutation = path.join(scratchDir, "mutations");
      expect(fs.existsSync(mutation) ? fs.readdirSync(mutation) : []).toEqual([]);
    } finally {
      await registry.terminateAll();
      record.mockRestore();
      guard?.mockRestore();
    }
  });

  it.each(["missing git", "unwritable wrapper"] as const)("refuses before any launch when preparation fails: %s", async (failure) => {
    const root = project([["a.txt", "old\n"]]);
    const scratchDir = path.join(root, "scratch");
    if (failure === "unwritable wrapper") fs.writeFileSync(scratchDir, "not a directory");
    const spawn = mutationSpawnProbe(() => { throw new Error("must not launch"); });
    const result = await createBashDefinition({
      operations: makeMockOps(),
      ...(failure === "missing git" ? { loginShellPath: () => path.join(root, "absent-bin") } : {}),
    }).execute({ command: "reshape", mutates: true }, makeContext({
      projectRoot: root, executionCwd: root, scratchDir, spawnOwned: spawn.spawnOwned,
    }));
    expect(result.outcome).toBe("error");
    expect(result.content).toContain("could not prepare the mutation Git wrapper");
    expect(result.content).toContain("was not launched");
    expect(spawn.launches).toEqual([]);
    expect(fs.readFileSync(path.join(root, "a.txt"), "utf8")).toBe("old\n");
  });
});
