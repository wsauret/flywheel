import { describe, expect, test } from "bun:test";
import { Redacted } from "effect";
import type { OwnedSecretResult } from "../../../../src/infra/owned-command.js";
import type { OwnedProcess, OwnedProcessExit } from "../../../../src/infra/owned-subprocess.js";
import type { OwnedLaunchOptions } from "../../../../src/infra/owned-subprocess-backend.js";
import {
  createKeyResolver,
  createOwnedCredentialCommandRunner,
  type CredentialCommandRunner,
} from "../../../../src/infra/auth/resolve-key.js";

function captured(value: string): OwnedSecretResult {
  return { tag: "captured", value: Redacted.make(value) };
}

function failed(exitCode: number | null, timedOut = false): OwnedSecretResult {
  return { tag: "failed", failure: { exitCode, timedOut } };
}

interface Launch {
  readonly argv: readonly string[];
  readonly options: OwnedLaunchOptions | undefined;
}

/** A launcher scope that records each launch and answers it with a helper that
 *  prints `stdout` and exits cleanly. */
function recordingScope(stdout: string) {
  const launches: Launch[] = [];
  const exited = Promise.resolve<OwnedProcessExit>({ code: 0, signal: null, statusOf: "payload", ownership: "surrendered" });
  const stream = (text: string) =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        if (text.length > 0) controller.enqueue(new TextEncoder().encode(text));
        controller.close();
      },
    });
  const scope = {
    spawnOwned(argv: readonly string[], options?: OwnedLaunchOptions): Promise<OwnedProcess> {
      launches.push({ argv: [...argv], options });
      return Promise.resolve({ pid: 4242, token: "owned:test", stdin: undefined, stdout: stream(stdout), stderr: stream(""), exited, terminate: () => exited });
    },
  };
  return { scope, launches };
}

/** The command line the launched shell parses. cmd expands `%NAME%` from the
 *  launch environment before it parses, and Windows argument quoting escapes
 *  each `"` as `\"`, which cmd does not read, so on Windows no argument may
 *  carry a quote. */
function commandTheShellParses({ argv, options }: Launch): string {
  const line = argv.at(-1) ?? "";
  if (process.platform !== "win32") return line;
  expect(argv.filter((arg) => arg.includes('"'))).toEqual([]);
  return line.replace(/%([^%]+)%/g, (whole, name: string) => options?.env?.[name] ?? whole);
}

/** A runner that records what it was asked for, so a test can prove how many
 *  operations one credential caused. */
function recordingRunner(answer: (command: string) => Promise<OwnedSecretResult>) {
  const commands: string[] = [];
  const run: CredentialCommandRunner = (command) => {
    commands.push(command);
    return answer(command);
  };
  return { run, commands };
}

describe("a key resolver", () => {
  test("returns a literal value without running anything", async () => {
    const runner = recordingRunner(() => Promise.reject(new Error("a literal key must not launch")));
    const resolve = createKeyResolver(runner.run);

    const result = await resolve("[redacted secret]");

    expect(result && Redacted.value(result)).toBe("[redacted secret]");
    expect(runner.commands).toEqual([]);
  });

  test("runs the command a leading ! names and returns its key", async () => {
    const runner = recordingRunner(() => Promise.resolve(captured("helper-key")));
    const resolve = createKeyResolver(runner.run);

    const result = await resolve("!print-my-key --scope work");

    expect(result && Redacted.value(result)).toBe("helper-key");
    expect(runner.commands).toEqual(["print-my-key --scope work"]);
  });

  test("resolves one credential once, however many readers ask", async () => {
    const runner = recordingRunner(() => Promise.resolve(captured("helper-key")));
    const resolve = createKeyResolver(runner.run);

    const first = await resolve("!print-my-key");
    const second = await resolve("!print-my-key");

    expect(first && Redacted.value(first)).toBe("helper-key");
    expect(second && Redacted.value(second)).toBe("helper-key");
    expect(runner.commands).toEqual(["print-my-key"]);
  });

  test("readers that arrive while the helper is running join one operation", async () => {
    let release: (result: OwnedSecretResult) => void = () => {};
    const pending = new Promise<OwnedSecretResult>((settle) => { release = settle; });
    const runner = recordingRunner(() => pending);
    const resolve = createKeyResolver(runner.run);

    const both = Promise.all([resolve("!print-my-key"), resolve("!print-my-key")]);
    release(captured("helper-key"));
    const [first, second] = await both;

    expect(first && Redacted.value(first)).toBe("helper-key");
    expect(second && Redacted.value(second)).toBe("helper-key");
    expect(runner.commands).toEqual(["print-my-key"]);
  });

  test("keeps each credential's operation to itself", async () => {
    const runner = recordingRunner((command) => Promise.resolve(captured(`${command}-key`)));
    const resolve = createKeyResolver(runner.run);

    const first = await resolve("!work-key");
    const second = await resolve("!home-key");

    expect(first && Redacted.value(first)).toBe("work-key-key");
    expect(second && Redacted.value(second)).toBe("home-key-key");
    expect(runner.commands).toEqual(["work-key", "home-key"]);
  });

  test("reports no key when the helper could not be run at all", async () => {
    const runner = recordingRunner(() => Promise.reject(new Error("launcher scope is closed")));
    const resolve = createKeyResolver(runner.run);

    expect(await resolve("!print-my-key")).toBeUndefined();
  });

  test("hands the shell a helper command with quoted parts intact", async () => {
    const { scope, launches } = recordingScope("helper-key\n");
    const resolve = createKeyResolver(createOwnedCredentialCommandRunner(scope));
    const command = `"C:\\Program Files\\x\\op.exe" read "op://vault/key" | findstr key`;

    const result = await resolve(`!${command}`);

    expect(result && Redacted.value(result)).toBe("helper-key");
    expect(launches).toHaveLength(1);
    expect(commandTheShellParses(launches[0]!)).toBe(command);
  });

  test("retries a helper that first fails and then delivers", async () => {
    const answers = [failed(null, true), captured("late-key")];
    const runner = recordingRunner(() => Promise.resolve(answers.shift() ?? failed(1)));
    const resolve = createKeyResolver(runner.run);

    expect(await resolve("!slow-helper")).toBeUndefined();
    const second = await resolve("!slow-helper");

    expect(second && Redacted.value(second)).toBe("late-key");
  });
});
