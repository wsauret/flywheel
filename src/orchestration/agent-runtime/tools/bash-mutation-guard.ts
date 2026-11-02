/**
 * The OS guard that keeps one mutating command from writing the real project
 * through an absolute path its command text does not show, such as a path a
 * script builds at run time.
 *
 * On macOS the command runs under a Seatbelt profile that denies writes under
 * the repository's existing registered trees and Git directories except through the entries
 * the selected copy shares. Linux makes these paths read-only with bubblewrap.
 * Both guards keep the session scratch directory and copy home writable.
 * Where the host allows it, the Linux guard also runs the command as the
 * first process of its own process namespace, which the kernel ends with
 * every process in it when the command ends. So on Linux a background process
 * that a mutating command starts ends with that command, and nothing it
 * started can write into the copy after its landing.
 * Windows runs without an OS guard. A macOS or Linux host that refuses its
 * guard runs the command without capture, in place.
 */

import { realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { errnoCode, errorMessage } from "../../../infra/error-message.js";
import { Log } from "../../../infra/log.js";
import type { OwnedCommandRunner } from "../../../infra/owned-command.js";
import type { LandableCopy, PrivateProjectCopy } from "./bash-private-copy.js";

const log = Log.create({ service: "bash-mutation-guard" });

export type MutationGuardKind = "seatbelt" | "mount-namespace" | "none";

/** The guard this host applies. `pidNamespace` is true when the Linux guard
 *  also gives each command its own process namespace (see the module comment). */
export interface MutationGuard {
  readonly kind: MutationGuardKind;
  readonly pidNamespace: boolean;
}

// Without its own `/proc`, a command in the namespace reads the host's process
// table, where its own process id differs, and `ps` fails. A host that masks
// `/proc` (a container without privileges) refuses this mount but can still
// allow the plain guard.
const PID_NAMESPACE = ["--unshare-pid", "--die-with-parent", "--proc", "/proc"];

type GuardedCopy = Pick<PrivateProjectCopy, "home" | "realRoot" | "copyRoot" | "shared"> & Partial<Pick<LandableCopy, "git"> & Pick<PrivateProjectCopy, "scratchDir">>;

const SANDBOX_EXEC = "/usr/bin/sandbox-exec";
const PROBE_TIMEOUT_MS = 10_000;

let hostGuard: Promise<MutationGuard> | undefined;

/** The guard this host applies, probed on the first `mutates` command and kept for the life of the process. */
export function hostMutationGuard(run: OwnedCommandRunner): Promise<MutationGuard> {
  hostGuard ??= probeMutationGuard(run, process.platform);
  return hostGuard;
}

/** Starts the platform's guard around a command that does nothing. A guard
 *  is selected only when that exits 0; a launcher that is missing, refused, or
 *  failing selects `none`. On Linux the guard with its own process namespace
 *  is tried first, then the plain guard. Never throws. */
export async function probeMutationGuard(run: OwnedCommandRunner, platform: NodeJS.Platform): Promise<MutationGuard> {
  const probes = platform === "darwin"
    ? [{ kind: "seatbelt", pidNamespace: false, argv: [SANDBOX_EXEC, "-p", "(version 1)(allow default)", "/usr/bin/true"] }] as const
    : platform === "linux" ? [
      { kind: "mount-namespace", pidNamespace: true, argv: ["bwrap", "--dev-bind", "/", "/", ...PID_NAMESPACE, "true"] },
      { kind: "mount-namespace", pidNamespace: false, argv: ["bwrap", "--dev-bind", "/", "/", "true"] },
    ] as const : [];
  for (const { argv, ...guard } of probes) {
    try {
      const result = await run(argv, { timeoutMs: PROBE_TIMEOUT_MS });
      log.debug("bash mutation guard probed", { ...guard, exitCode: result.exitCode });
      if (result.exitCode === 0) return guard;
    } catch (error) {
      log.debug("bash mutation guard probe failed", { ...guard, error: errorMessage(error) });
    }
  }
  return { kind: "none", pidNamespace: false };
}

/** Returns the argv that runs `argv` under the guard for `copy`. Missing
 *  registered worktrees are omitted; missing required paths fail setup or launch. */
export function guardedArgv(guard: MutationGuard, copy: GuardedCopy): (argv: readonly string[]) => string[] {
  switch (guard.kind) {
    case "seatbelt": {
      const profile = seatbeltProfile(copy);
      return argv => [SANDBOX_EXEC, "-p", profile, ...argv];
    }
    case "mount-namespace": {
      const roots = protectedRoots(copy);
      const readOnlyBind = (path: string, target = path): string[] => [roots.get(path) === "optional" ? "--ro-bind-try" : "--ro-bind", path, target];
      const binds = [
        ...[...roots.keys()].flatMap(path => readOnlyBind(path)),
        ...copy.shared.flatMap(path => ["--bind", join(copy.realRoot, path), join(copy.realRoot, path)]),
        // A shared ancestor can contain another registered tree or the Git directory.
        ...finalReadOnlyRoots(copy).flatMap(path => readOnlyBind(path)),
        ...[copy.scratchDir, copy.home].filter((path): path is string => path !== undefined).flatMap(path => ["--bind", path, path]),
        ...rootsInsideWritableHomes(copy).flatMap(path => readOnlyBind(path)),
        ...copy.shared.flatMap(path => ["--bind", join(copy.realRoot, path), join(copy.copyRoot, path)]),
        ...finalReadOnlyRoots(copy).flatMap(root => {
          const path = relative(copy.realRoot, root);
          // A writable bind is a second mount, so it needs its own read-only child mounts.
          return copy.shared.some(shared => path === shared || path.startsWith(`${shared}${sep}`))
            ? readOnlyBind(root, join(copy.copyRoot, path)) : [];
        }),
      ];
      return argv => ["bwrap", "--dev-bind", "/", "/", ...(guard.pidNamespace ? PID_NAMESPACE : []), ...binds, "--", ...argv];
    }
    case "none":
      return argv => [...argv];
  }
}

/** Allows everything except writes under the repository's trees and Git directories.
 *  Shared entries, scratch, and the copy home remain writable. Seatbelt matches
 *  resolved paths, and the last matching rule wins. */
export function seatbeltProfile(copy: GuardedCopy): string {
  const allowed = copy.shared.map(path => join(copy.realRoot, path));
  const roots = [...protectedRoots(copy)].flatMap(([path, requirement]) => {
    try {
      return [{ path, resolved: realpathSync(path) }];
    } catch (error) {
      // Another process can delete a registered worktree after Git discovery.
      if (requirement === "optional" && errnoCode(error) === "ENOENT") return [];
      throw error;
    }
  });
  const finalRoots = new Set(finalReadOnlyRoots(copy));
  const rootsInWritableHomes = new Set(rootsInsideWritableHomes(copy));
  const ancestors = new Set<string>();
  for (const root of roots) {
    for (let path = dirname(root.resolved); ; path = dirname(path)) {
      ancestors.add(path);
      if (path === dirname(path)) break;
    }
  }
  return [
    "(version 1)",
    "(allow default)",
    ...roots.map(root => `(deny file-write* (subpath ${sbplString(root.resolved)}))`),
    // An allow rule with no filter would allow every write, so it exists only with paths.
    ...(allowed.length > 0 ? [`(allow file-write* ${allowed.map(path => `(subpath ${sbplString(realpathSync(path))})`).join(" ")})`] : []),
    ...roots.filter(root => finalRoots.has(root.path)).map(root => `(deny file-write* (subpath ${sbplString(root.resolved)}))`),
    `(allow file-write* ${[copy.scratchDir, copy.home].filter((path): path is string => path !== undefined).map(path => `(subpath ${sbplString(realpathSync(path))})`).join(" ")})`,
    ...roots.filter(root => rootsInWritableHomes.has(root.path)).map(root => `(deny file-write* (subpath ${sbplString(root.resolved)}))`),
    // A writable ancestor must not relocate a protected subtree out of its rule.
    ...[...ancestors].map(path => `(deny file-write-unlink (literal ${sbplString(path)}))`),
  ].join("\n");
}

function rootsInsideWritableHomes(copy: GuardedCopy): string[] {
  return [...protectedRoots(copy).keys()].filter(root => [copy.scratchDir, copy.home].some(home => {
    if (!home) return false;
    const path = relative(home, root);
    return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`));
  }));
}

/** Seatbelt denies a write with EPERM, which the writing tool reports next to
 *  the path it tried. A line that names the real root outside the copy's home
 *  shows such a denial, and the returned note tells the agent why. */
export function deniedWriteNote(kind: MutationGuardKind, copy: Pick<GuardedCopy, "home" | "realRoot" | "git"> & Partial<Pick<GuardedCopy, "copyRoot" | "shared">>, output: string): string | undefined {
  if (kind === "none") return undefined;
  const roots = [...protectedRoots(copy).keys()];
  const aliases = new Map(roots.map(root => {
    const path = relative(copy.realRoot, root);
    const shared = copy.shared?.some(entry => path === entry || path.startsWith(`${entry}${sep}`));
    return [root, shared && copy.copyRoot ? join(copy.copyRoot, path) : undefined];
  }));
  const mentions = (line: string, root: string): boolean => {
    const alias = aliases.get(root);
    const outsideCopy = line.split(copy.home).map((part, index) => index === 0 ? part : part.replace(/^[^\s'"]*/, "")).join("");
    return (root.startsWith(`${copy.home}${sep}`) ? line.includes(root) : outsideCopy.includes(root)) || (alias !== undefined && line.includes(alias));
  };
  const refusals = output.split("\n").filter(line => /operation not permitted|permission denied|read-only file system/i.test(line) && (!line.includes(copy.home) || roots.some(root => mentions(line, root)) || /\b(?:to|->)\s/.test(line)));
  const denied = roots.filter(root => refusals.some(line => mentions(line, root)));
  return denied.length > 0
    ? `A write under ${denied.join(", ")} was denied: this command runs in a private copy of the project. Set cwd to the target tree to change it.`
    : refusals.length > 0
      ? `A write was refused. This command protects these trees and Git directories: ${roots.join(", ")}. Set cwd to the target tree to change it.`
      : undefined;
}

function gitRoots(copy: Pick<GuardedCopy, "git">): string[] {
  return copy.git?.kind === "repository" ? [...new Set([copy.git.gitDir, copy.git.commonDir])] : [];
}

function finalReadOnlyRoots(copy: Pick<GuardedCopy, "realRoot" | "git">): string[] {
  const others = copy.git?.kind === "repository" ? copy.git.workTrees.filter(tree => {
    const selected = relative(tree, copy.realRoot);
    return selected === ".." || selected.startsWith(`..${sep}`) || isAbsolute(selected);
  }) : [];
  return [...new Set([...others, ...gitRoots(copy)])];
}

function protectedRoots(copy: Pick<GuardedCopy, "realRoot" | "git">): Map<string, "required" | "optional"> {
  const roots = new Map<string, "required" | "optional">([[copy.realRoot, "required"]]);
  for (const tree of copy.git?.kind === "repository" ? copy.git.workTrees : []) {
    if (!roots.has(tree)) roots.set(tree, "optional");
  }
  for (const root of gitRoots(copy)) roots.set(root, "required");
  return roots;
}

function sbplString(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"")}"`;
}
