/** The shared harness of the bash `mutates` unit tests: a physical project
 *  directory and one `mutates: true` call over injected operations. */

import { afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

import type { OwnedProcess } from "../../../../../src/infra/owned-subprocess.js";
import { createBashDefinition } from "../../../../../src/orchestration/agent-runtime/tools/bash.js";
import type { ToolContext } from "../../../../../src/orchestration/agent-runtime/tools/types.js";
import type { ShellRuntime, ShellRuntimeClient } from "../../../../../src/orchestration/agent-runtime/tools/shell-runtime-types.js";
import { commandOutputOps, mutationSpawnProbe, makeMockOps, makeMockOwnedProcess, type MergeFileFake, type OwnedExit } from "./_bash-fixtures.js";
import { capabilityAccessHolding, createRecordingFileMutationStore, makeContext } from "./_fixtures.js";
import { createBackgroundWorkRegistry, type BackgroundWorkRegistry, type SettledProjectMutation } from "../../../../../src/orchestration/agent-runtime/background-work.js";
import { createForegroundBashHoldController } from "../../../../../src/orchestration/agent-runtime/foreground-bash-hold.js";
import { backgroundLogPath } from "../../../../helpers/background-log-path.js";
import { asAsyncEventReadSurface, asAsyncEventWriter } from "../../../../../src/infra/event-store-types.js";
import { resolveEventStoreDbFile } from "../../../../../src/infra/paths.js";
import { createSqliteEventStore } from "../../../../../src/infra/sqlite-event-store.js";
import { createBackgroundExecutionOwner } from "../../../../../src/orchestration/agent-runtime/background-execution-owner.js";
import { commandHandoversOfAsync } from "../../../../../src/orchestration/session/command-handover.js";
import type { OutcomeRecordRead } from "../../../../../src/infra/command-handover.js";
import { fakeContainer, handoverAuthority } from "../_command-handover-fixtures.js";
import { createPrivateCopyPool, type PrivateCopyPool } from "../../../../../src/orchestration/agent-runtime/tools/bash-private-copy-pool.js";
import { createShellRuntime } from "../../../../../src/orchestration/agent-runtime/tools/shell-runtime.js";
import type { ContainerProbe } from "../../../../../src/infra/process-container.js";

/** A call's context overrides. `shell` is the session shell runtime that runs
 *  the call; without one, the call runs on a runtime of its own. */
export type BashCallOverrides = Partial<ToolContext> & { readonly shell?: ShellRuntimeClient };

/** A call without a session shell runs on a shell runtime of its own, which
 *  closes after the case or at `closeShells`; a case that reuses copies runs
 *  on `bashMutationSession`. */
export function bashMutationHarness(createDirectory: (prefix: string) => string) {
  const runtimes: ShellRuntime[] = [];
  /** Closes the shell runtime of every call so far, whose pool waits for each copy removal it started. */
  async function closeShells(): Promise<void> {
    for (const runtime of runtimes.splice(0)) await runtime.close();
  }
  afterEach(closeShells);
  function caseShell(registry: BackgroundWorkRegistry = createBackgroundWorkRegistry({ kind: "chat", enqueueNotification: () => {} })): ShellRuntimeClient {
    const runtime = createShellRuntime(registry, { privateCopies: createPrivateCopyPool({ probe: processTableProbe(new Map()) }) });
    runtimes.push(runtime);
    return runtime.client;
  }

  function project(files: ReadonlyArray<readonly [string, string | Uint8Array]>) {
    const root = fs.realpathSync(createDirectory("agent-bash-mutations-"));
    for (const [name, content] of files) {
      fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
      fs.writeFileSync(path.join(root, name), content);
    }
    return root;
  }

  async function runMutation(root: string, mutate: (cwd: string) => void, input: { readonly command?: string; readonly cwd?: string; readonly background?: boolean; readonly persist_after_exit?: boolean; readonly timeout?: number } = {}, overrides: BashCallOverrides = {}, launch: { readonly make?: () => OwnedProcess; readonly mergeFile?: MergeFileFake } = {}) {
    const { shell = caseShell(), ...context } = overrides;
    const scripts: string[] = [];
    const store = createRecordingFileMutationStore();
    const spawn = mutationSpawnProbe(mutate, launch.make, launch.mergeFile);
    // The command prints `mock output` to its log, which managed execution reads as its output.
    const def = createBashDefinition({ shell, foregroundBashHold: createForegroundBashHoldController(() => {}), operations: commandOutputOps("mock output\n", {
      ensureDir: (dir) => { fs.mkdirSync(dir, { recursive: true }); },
      async writeScript(_path, content) { scripts.push(content); return content.length; },
    }) });
    const result = await def.execute({ command: "reshape", mutates: true, ...input }, makeContext({
      projectRoot: root, executionCwd: root, scratchDir: path.join(root, ".flywheel", "sessions", "session-1", "scratch"),
      spawnOwned: spawn.spawnOwned, toolUseId: "bash-1", sessionEventWriter: store.writer, ...context,
    }));
    return { result, scripts, store, launches: spawn.launches };
  }

  /** Runs a mutating command through the managed path: `background` launches it
   *  there, and a held `exit` lets the 5 ms runtime cap transfer it. A
   *  function in place of `exit` makes the command's container. */
  async function runManagedMutation(root: string, mutate: (cwd: string) => void, input: { readonly background?: boolean }, exit?: Promise<OwnedExit> | (() => OwnedProcess), overrides: BashCallOverrides = {}, mergeFile?: MergeFileFake) {
    const order: string[] = [];
    const notifications: string[] = [];
    const recorded: Array<{ readonly toolUseId: string; readonly output: string; readonly mutation: SettledProjectMutation }> = [];
    const registry = createBackgroundWorkRegistry({
      kind: "chat",
      enqueueNotification: (text) => { order.push("notified"); notifications.push(text); },
      onExecutionOutputRecorded: (toolUseId, output, _identity, mutation) => { order.push("recorded"); recorded.push({ toolUseId, output, mutation }); },
    });
    const { shell = caseShell(registry), ...context } = overrides;
    const store = createRecordingFileMutationStore();
    const spawn = mutationSpawnProbe(mutate, typeof exit === "function" ? exit : exit ? () => makeMockOwnedProcess({ exited: exit }) : undefined, mergeFile);
    const def = createBashDefinition({
      shell,
      foregroundBashHold: createForegroundBashHoldController(() => {}),
      totalYieldMs: 5,
      operations: makeMockOps({
        ensureDir: (dir) => { fs.mkdirSync(dir, { recursive: true }); },
        async writeScript(_path, content) {
          const log = backgroundLogPath(content);
          if (log) await Bun.write(log, "");
          return content.length;
        },
      }),
    });
    const result = await def.execute({ command: "reshape", mutates: true, ...input }, makeContext({
      projectRoot: root, executionCwd: root, scratchDir: path.join(root, ".flywheel", "sessions", "session-1", "scratch"),
      spawnOwned: spawn.spawnOwned, toolUseId: "bash-1", sessionEventWriter: store.writer,
      capabilityAccess: capabilityAccessHolding(["background-commands"]),
      ...context,
    }));
    return { result, registry, order, notifications, recorded, store };
  }

  /** Runs a background mutation command on one build, which hands it to the next
   *  build at its stop for a planned replacement, and adopts it on the next
   *  build, where it then ends; with `endedBetween` it ended while no build
   *  held it, and the next build settles it from what its supervisor recorded.
   *  `crossing` runs with the home of the command's copy while no build holds
   *  the command. Answers what the launching build had done to the project
   *  once the command's end reached it too, and what the adopting build
   *  recorded and published. */
  async function runHandedOverMutation(root: string, mutate: (cwd: string) => void, options: { readonly mergeFile?: MergeFileFake; readonly crossing?: (home: string) => void; readonly endedBetween?: Exclude<OutcomeRecordRead, { readonly kind: "unreadable" }> } = {}) {
    const { mergeFile } = options;
    const store = createSqliteEventStore(resolveEventStoreDbFile(createDirectory("agent-bash-mutations-store-")));
    const writer = asAsyncEventWriter(store);
    const conversation = { sessionId: "session-1", conversationId: "conversation-1" };
    const launched = fakeContainer([], "handed_over");
    const launch = mutationSpawnProbe(mutate, () => launched.owned, mergeFile);
    const launching = createBackgroundExecutionOwner(createBackgroundWorkRegistry({ kind: "chat", enqueueNotification: () => {} }), {
      ...conversation, holder: "conversation", deliver: async () => {},
      authority: handoverAuthority({ reader: store, writer, stopping: true }),
    });
    await createBashDefinition({
      shell: launching.shell,
      foregroundBashHold: createForegroundBashHoldController(() => {}),
      operations: makeMockOps({
        ensureDir: (dir) => { fs.mkdirSync(dir, { recursive: true }); },
        async writeScript(_path, content) {
          const log = backgroundLogPath(content);
          if (log) await Bun.write(log, "");
          return content.length;
        },
      }),
    }).execute({ command: "reshape", mutates: true, background: true }, makeContext({
      projectRoot: root, executionCwd: root, scratchDir: path.join(root, ".flywheel", "sessions", "session-1", "scratch"), toolUseId: "bash-1", sessionId: conversation.sessionId,
      // The mutation guard's probe names no working directory and ends at once; the command's launch is the container handed over.
      spawnOwned: (cmd, spawnOptions) => spawnOptions?.cwd === undefined && cmd[0] !== "git" ? Promise.resolve(makeMockOwnedProcess()) : launch.spawnOwned(cmd, spawnOptions),
      capabilityAccess: capabilityAccessHolding(["background-commands"]),
    }));
    await launching.close();
    if ((await commandHandoversOfAsync(asAsyncEventReadSurface(store), conversation.sessionId, conversation.conversationId)).length !== 1) throw new Error("the command was not handed over");
    const [copy] = fs.readdirSync(path.join(root, ".flywheel", "sessions", "session-1", "scratch", "mutations"));
    const home = path.join(root, ".flywheel", "sessions", "session-1", "scratch", "mutations", copy!);
    // The end of a container that was handed over reaches no owner of this build.
    launched.end(0);
    await Bun.sleep(20);
    const beforeAdoption = { files: fs.readdirSync(root).toSorted(), facts: store.read({ sessionId: conversation.sessionId, types: ["file.changed"] }).length, copy: fs.existsSync(home) };
    options.crossing?.(home);

    const adopted = fakeContainer([]);
    const order: string[] = [];
    const notifications: string[] = [];
    const recorded: Array<{ readonly toolUseId: string; readonly output: string; readonly mutation: SettledProjectMutation }> = [];
    const registry = createBackgroundWorkRegistry({
      kind: "chat",
      enqueueNotification: (text) => { order.push("notified"); notifications.push(text); },
      onExecutionOutputRecorded: (toolUseId, output, _identity, mutation) => { order.push("recorded"); recorded.push({ toolUseId, output, mutation }); },
    });
    const adopting = createBackgroundExecutionOwner(registry, {
      ...conversation, holder: "conversation",
      deliver: async (completion) => { order.push("delivered"); notifications.push(completion.text); },
      authority: handoverAuthority({
        reader: store, writer, spawnOwned: mutationSpawnProbe(() => {}, undefined, mergeFile).spawnOwned,
        adopt: () => options.endedBetween ? { kind: "ended", record: options.endedBetween } : { kind: "adopted", owned: adopted.owned },
      }),
    });
    await adopting.adoptHandedOver();
    adopted.end(0);
    await settled(registry);
    await adopting.close();
    const fileChanges = store.read({ sessionId: conversation.sessionId, types: ["file.changed"] }).map((fact) => fact.payload);
    store.close();
    return { beforeAdoption, launchingPool: launching.shell.privateCopies, order, notifications, recorded, fileChanges };
  }

  return { project, runMutation, runManagedMutation, runHandedOverMutation, caseShell, closeShells };
}

/** One simulated session: a shell runtime on its own registry, whose pool
 *  reads `processes` as the host's process table. The table lists the mock
 *  containers' pid as started at the launch, so it proves that no process of
 *  a command survives until a case adds one; the real table knows nothing of
 *  that fake pid and would retire every copy. Pass `context` as the
 *  overrides of each command of the session. `removed` resolves once every
 *  removal its commands asked the pool for has ended, while the pool still
 *  holds its idle copy, which its close would discard. */
export function bashMutationSession() {
  const processes: ProcessTable = new Map([[makeMockOwnedProcess().pid, { start: "100", ppid: 2 }]]);
  const registry = createBackgroundWorkRegistry({ kind: "chat", enqueueNotification: () => {} });
  const pool = createPrivateCopyPool({ probe: processTableProbe(processes) });
  const removals: Promise<void>[] = [];
  const privateCopies: PrivateCopyPool = { ...pool, discard: (copy) => {
    const removal = pool.discard(copy);
    removals.push(removal);
    return removal;
  } };
  const runtime = createShellRuntime(registry, { privateCopies });
  return { processes, registry, runtime, removed: async () => { await Promise.all(removals); }, context: { shell: runtime.client } satisfies BashCallOverrides };
}

type ProcessTable = Map<number, { readonly start: string; readonly ppid: number }>;

/** A process probe that reads `processes` as the host's process table. */
function processTableProbe(processes: ProcessTable): ContainerProbe {
  const pids = () => [...processes.keys()];
  return {
    signal: () => undefined,
    groupExists: () => false,
    libproc: {
      query(pid) {
        const entry = processes.get(pid);
        return entry ? { kind: "process", pgid: pid, ppid: entry.ppid, identity: `${pid} ${pid} ${entry.start}`, start: entry.start } : { kind: "absent" };
      },
      group: () => [],
      pids,
      children: (pid) => pids().filter((child) => processes.get(child)?.ppid === pid),
      executable: () => ({ kind: "unavailable" }),
      processArguments: () => undefined,
      environment: () => undefined,
      bootSession: () => undefined,
      footprintBytes: () => undefined,
      runnableThreads: () => undefined,
    },
  };
}

export async function settled(registry: { activeTaskCount(): number }): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (registry.activeTaskCount() > 0) {
    if (Date.now() > deadline) throw new Error("background command did not settle");
    await Bun.sleep(5);
  }
}
