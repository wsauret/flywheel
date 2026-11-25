import { Redacted } from "effect";

import { Log } from "../../diagnostics/log.js";
import { captureOwnedSecret, type OwnedSecretResult } from "../../owned-command.js";
import type { LauncherScope } from "../../process-supervisor.js";
import { shellCommandLaunch } from "../../platform/shell-command.js";

const log = Log.create({ service: "resolve-key" });

const COMMAND_TIMEOUT_MS = 10_000;

/** Runs one `!command` credential helper. Injected, so auth resolution needs no
 *  launch capability of its own. The result is the capture seam's own outcome:
 *  a `Redacted` key, or exit metadata and nothing else. */
export type CredentialCommandRunner = (command: string) => Promise<OwnedSecretResult>;

/** Resolves one configured key: a literal value, or the output of the helper a
 *  leading `!` names. */
export type KeyResolver = (value: string) => Promise<Redacted.Redacted<string> | undefined>;

/** The production runner: the helper runs in a container the guardian owns and
 *  its output is captured as a secret, never as text. */
export function createOwnedCredentialCommandRunner(scope: Pick<LauncherScope, "spawnOwned">): CredentialCommandRunner {
  return (command) => {
    const { argv, env } = shellCommandLaunch(command);
    return captureOwnedSecret(scope, argv, { timeoutMs: COMMAND_TIMEOUT_MS, env });
  };
}

export function createKeyResolver(run: CredentialCommandRunner): KeyResolver {
  // One resolution per helper per resolver. Re-running the helper on every
  // auth-context read would be slow and could re-prompt a credential agent, so
  // the entry is the operation itself: concurrent readers of one credential
  // join the flight already running instead of starting a second. A helper that
  // delivered nothing is dropped rather than remembered, so the next read
  // retries it.
  const resolutions = new Map<string, Promise<Redacted.Redacted<string> | undefined>>();

  return (value) => {
    if (!value.startsWith("!")) return Promise.resolve(Redacted.make(value));
    const running = resolutions.get(value);
    if (running) return running;

    const resolution = run(value.slice(1)).then(
      (result) => {
        if (result.tag === "captured") return result.value;
        log.info("credential helper delivered no key", { exitCode: result.failure.exitCode, timedOut: result.failure.timedOut });
        resolutions.delete(value);
        return undefined;
      },
      () => {
        // A launch that never happened: the scope refused it, or the shell is
        // missing. The reason is not reported, because a rejection raised
        // around a credential helper is the one place a partial secret could
        // ride out in an error message.
        log.info("credential helper could not be run");
        resolutions.delete(value);
        return undefined;
      },
    );
    resolutions.set(value, resolution);
    return resolution;
  };
}
