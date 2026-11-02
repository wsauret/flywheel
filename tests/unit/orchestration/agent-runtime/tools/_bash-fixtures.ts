import { lstatSync, mkdirSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import type { OwnedProcess } from "../../../../../src/infra/owned-subprocess.js";
import type { BashOperations, ToolContext } from "../../../../../src/orchestration/agent-runtime/tools/types.js";

type StreamChunk = string | Uint8Array;

export function streamOf(input: string | readonly StreamChunk[]): ReadableStream<Uint8Array> {
  const chunks = typeof input === "string" ? [input] : input;
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(c) {
      for (const chunk of chunks) {
        c.enqueue(typeof chunk === "string" ? encoder.encode(chunk) : chunk);
      }
      c.close();
    },
  });
}

type OwnedSpawn = NonNullable<ToolContext["spawnOwned"]>;
export type OwnedExit = Awaited<OwnedProcess["exited"]>;

export function makeMockOwnedProcess(overrides?: Partial<OwnedProcess>): OwnedProcess {
  const exit: OwnedExit = { code: 0, signal: null, statusOf: "payload", ownership: "surrendered" };
  return {
    pid: 12345,
    token: "owned:mock",
    stdin: undefined,
    stdout: streamOf("mock output\n"),
    stderr: new ReadableStream({ start(c) { c.close(); } }),
    exited: Promise.resolve(exit),
    terminate: async () => exit,
    ...overrides,
  };
}

export interface OwnedSpawnProbe {
  readonly spawnOwned: OwnedSpawn;
  /** One entry per launch, in order. */
  readonly launches: Array<{ cmd: readonly string[]; cwd: string | undefined; env: { [key: string]: string | undefined } | undefined; stdin?: "ignore"; handover?: boolean }>;
  /** Containers this tool asked its owner to terminate, in order. */
  readonly terminated: number[];
}

/** Stands in for the runtime generation's launcher: every launch is recorded
 *  and answered with a container the test drives. */
export function ownedSpawnProbe(make: () => OwnedProcess = () => makeMockOwnedProcess()): OwnedSpawnProbe {
  const launches: OwnedSpawnProbe["launches"] = [];
  const terminated: number[] = [];
  return {
    launches,
    terminated,
    spawnOwned: async (cmd, options) => {
      launches.push({ cmd, cwd: options?.cwd, env: options?.env, ...(options?.stdin ? { stdin: options.stdin } : {}), ...(options?.handover === undefined ? {} : { handover: options.handover }) });
      const owned = make();
      return {
        ...owned,
        terminate: () => {
          terminated.push(owned.pid);
          return owned.terminate();
        },
      };
    },
  };
}

/** Stands in for `git merge-file` in hermetic tests: it receives the argv
 *  labels and the three input paths, writes its result into `current` as Git
 *  does, and returns the exit code Git would. */
export type MergeFileFake = (merge: { readonly labels: readonly string[]; readonly current: string; readonly base: string; readonly other: string }) => number;

/** A launcher for `mutates` commands outside a Git repository: Git probes exit
 *  128, and each shell launch first runs `mutate` in the directory it was
 *  given, which is the command's place in its private copy. `make` answers
 *  each shell launch, so a case can hold the command's exit, and `mergeFile`
 *  answers `git merge-file`, which fails the case when it is absent. */
export function mutationSpawnProbe(mutate: (cwd: string) => void, make?: () => OwnedProcess, mergeFile?: MergeFileFake): OwnedSpawnProbe {
  const probe = ownedSpawnProbe(make);
  const exited = (code: number) => Promise.resolve<OwnedExit>({ code, signal: null, statusOf: "payload", ownership: "surrendered" });
  return {
    ...probe,
    spawnOwned: async (cmd, options) => {
      if (cmd[0] === "git" && cmd[1] === "merge-file") {
        if (!mergeFile) throw new Error("unexpected git merge-file");
        const [current = "", base = "", other = ""] = cmd.slice(-3);
        return makeMockOwnedProcess({ stdout: streamOf(""), exited: exited(mergeFile({ labels: cmd.slice(2, -3), current, base, other })) });
      }
      if (cmd[0] === "git") return makeMockOwnedProcess({ stdout: streamOf(""), exited: exited(128) });
      const cwd = options?.cwd;
      if (cwd) withSharedBinds(cmd, () => mutate(cwd));
      return probe.spawnOwned(cmd, options);
    },
  };
}

/** On Linux the mutation guard runs the command under `bwrap`, which mounts
 *  each shared real path, such as `.flywheel`, onto the empty placeholder that
 *  the private copy holds for it. The fake launch mounts nothing. So while
 *  `mutate` runs, each placeholder becomes a link to its real path, as the
 *  copy on macOS holds, and the empty placeholder comes back after. */
function withSharedBinds(cmd: readonly string[], run: () => void): void {
  if (cmd[0] !== "bwrap") {
    run();
    return;
  }
  const end = cmd.indexOf("--");
  const binds: Array<{ readonly source: string; readonly target: string; readonly directory: boolean }> = [];
  for (let index = 1; index + 2 < end; index++) {
    const [flag, source, target] = [cmd[index], cmd[index + 1]!, cmd[index + 2]!];
    if (flag !== "--bind" || source === target) continue;
    const placeholder = lstatSync(target, { throwIfNoEntry: false });
    if (placeholder) binds.push({ source, target, directory: placeholder.isDirectory() });
  }
  for (const { source, target, directory } of binds) {
    if (directory) rmdirSync(target);
    else unlinkSync(target);
    symlinkSync(source, target);
  }
  try {
    run();
  } finally {
    for (const { target, directory } of binds) {
      if (!placedLink(target)) continue;
      unlinkSync(target);
      if (directory) mkdirSync(target);
      else writeFileSync(target, "");
    }
  }
}

/** Whether the link that `withSharedBinds` placed is still there. A case that
 *  moved the copy, or put a file where one of its directories was, removed it. */
function placedLink(target: string): boolean {
  try {
    return lstatSync(target, { throwIfNoEntry: false })?.isSymbolicLink() === true;
  } catch {
    return false;
  }
}

export function makeMockOps(overrides?: Partial<BashOperations>): BashOperations {
  return {
    writeScript: async () => 0,
    deleteScript: async () => {},
    ensureDir: () => {},
    writeExecutable: async () => {},
    ...overrides,
  };
}
