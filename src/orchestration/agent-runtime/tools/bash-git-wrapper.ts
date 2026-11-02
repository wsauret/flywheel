import { createHash, randomUUID } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runsThroughBun } from "../../../infra/cli-subprocess.js";
import { windowsGitForwarderPath } from "../../../infra/native-assets.js";
import { SCRATCH_MUTATION_GIT_DIR } from "../../../infra/paths.js";
import { isWindows, quoteBashSingle, type RuntimePlatform } from "./bash-script.js";
import { shellPathKey, type ShellEnvironment } from "./shell-environment.js";

interface MutationGitShim {
  /** The file name that PATH resolves for `git`. */
  readonly file: string;
  /** A short hash of what the shim runs: the exact POSIX shim text, or the Windows forwarder inside its immutable build.
   *  Another runtime, source, or release gets another folder, so an installed shim is never rewritten. */
  readonly directoryName: string;
  readonly source: string | undefined;
  /** The files the shim needs at run time, which live in the runtime's build or source snapshot. Once one is gone,
   *  no command can use the shim, because the build or snapshot that it runs was collected. */
  readonly runtimePaths: readonly string[];
  readonly install: (path: string) => void;
}

/** The file in a shim folder that lists the shim's `runtimePaths`, one per line. It is not executable, so PATH never
 *  resolves it as a command. */
const RUNTIME_RECORD = "runtime-paths";

function mutationGitShim(execPath: string, platform: RuntimePlatform): MutationGitShim {
  const source = runsThroughBun(execPath) ? fileURLToPath(new URL("../../../cli/index.ts", import.meta.url)) : undefined;
  const directoryName = (identity: string): string => createHash("sha256").update(identity).digest("hex").slice(0, 16);
  if (isWindows(platform)) {
    const forwarder = windowsGitForwarderPath();
    return { file: "git.exe", directoryName: directoryName(forwarder), source, runtimePaths: [forwarder], install: (path) => copyFileSync(forwarder, path) };
  }
  const argv = [execPath, ...(source ? ["--conditions=browser", source] : []), "--internal-role=mutation-git", "--"];
  const text = `#!/bin/sh\nexec ${argv.map(quoteBashSingle).join(" ")} "$@"\n`;
  return {
    file: "git",
    directoryName: directoryName(text),
    source,
    runtimePaths: [execPath, ...(source ? [source] : [])],
    install: (path) => {
      writeFileSync(path, text, { mode: 0o700 });
      chmodSync(path, 0o700);
    },
  };
}

/** The folder name under `<scratch>/mutation-git` that the runtime at `execPath` uses. The scratch sweep keeps this
 *  folder of its own runtime, which no command writes to after it is installed. */
export function mutationGitDirectoryName(execPath: string, platform: RuntimePlatform): string {
  return mutationGitShim(execPath, platform).directoryName;
}

/** Whether every file that the shim in `folder` runs still exists, so a command may still call it. A folder installed
 *  before the record existed has none and answers false, as does a record cut short by an interrupted install. */
export function mutationGitRuntimeExists(folder: string): boolean {
  let record: string;
  try {
    record = readFileSync(join(folder, RUNTIME_RECORD), "utf8");
  } catch {
    return false;
  }
  return record.split("\n").every((path) => existsSync(path));
}

/** Prepares a PATH-first Git boundary before capture starts. Failure refuses the launch.
 *  The shim folder `<scratchDir>/mutation-git/<runtime hash>` is shared by every command of the session on the same
 *  runtime, independent of copy cleanup and managed-command handover, and the idle scratch sweep removes it once its
 *  runtime is gone. An installed shim is only read: a mutating command writes nothing here, because per-command file
 *  events drive macOS `fseventsd` to full CPU. A missing shim is written to a temporary file and renamed into place,
 *  so a concurrent command sees either no shim or a complete one. */
export function prepareMutationGitEnvironment(input: {
  readonly env: ShellEnvironment;
  readonly scratchDir: string;
  readonly cwd: string;
  readonly platform: RuntimePlatform;
  readonly execPath: string;
}): ShellEnvironment {
  const env = { ...input.env };
  const pathKey = shellPathKey(env, input.platform);
  const realGit = Bun.which("git", { PATH: env[pathKey] ?? "", cwd: input.cwd });
  if (!realGit || !isAbsolute(realGit)) throw new Error("the real Git executable could not be resolved");
  if (!isAbsolute(input.execPath)) throw new Error("the mutation Git runtime must be absolute");
  const shim = mutationGitShim(input.execPath, input.platform);
  const directory = join(input.scratchDir, SCRATCH_MUTATION_GIT_DIR, shim.directoryName);
  const target = join(directory, shim.file);
  if (!existsSync(target)) installShim(shim, directory, target);
  env.FLYWHEEL_MUTATION_GIT_RUNTIME = input.execPath;
  if (shim.source) env.FLYWHEEL_MUTATION_GIT_SOURCE = shim.source;
  else delete env.FLYWHEEL_MUTATION_GIT_SOURCE;
  env.FLYWHEEL_MUTATION_GIT_REAL = realGit;
  env[pathKey] = env[pathKey] ? `${directory}${isWindows(input.platform) ? ";" : ":"}${env[pathKey]}` : directory;
  return env;
}

/** The runtime record is written before the shim, so an installed shim always has it. A concurrent installer writes
 *  the same bytes. A rename that fails while the target exists lost the race to a concurrent command that installed
 *  the same shim. */
function installShim(shim: MutationGitShim, directory: string, target: string): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeFileSync(join(directory, RUNTIME_RECORD), shim.runtimePaths.join("\n"), { mode: 0o600 });
  const temporary = join(directory, `.${shim.file}.${randomUUID()}`);
  try {
    shim.install(temporary);
    renameSync(temporary, target);
  } catch (error) {
    rmSync(temporary, { force: true });
    if (!existsSync(target)) throw error;
  }
}
