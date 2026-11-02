import { describe, expect, test } from "bun:test";
import { Redacted } from "effect";
import type { OwnedSecretResult } from "../../../../src/infra/owned-command.js";
import {
  createKeyResolver,
  type CredentialCommandRunner,
} from "../../../../src/infra/auth/resolve-key.js";

function captured(value: string): OwnedSecretResult {
  return { tag: "captured", value: Redacted.make(value) };
}

function failed(exitCode: number | null, timedOut = false): OwnedSecretResult {
  return { tag: "failed", failure: { exitCode, timedOut } };
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

  test("retries a helper that first fails and then delivers", async () => {
    const answers = [failed(null, true), captured("late-key")];
    const runner = recordingRunner(() => Promise.resolve(answers.shift() ?? failed(1)));
    const resolve = createKeyResolver(runner.run);

    expect(await resolve("!slow-helper")).toBeUndefined();
    const second = await resolve("!slow-helper");

    expect(second && Redacted.value(second)).toBe("late-key");
  });
});
