import { afterEach, expect, spyOn, test } from "bun:test";
import { benchmarkCommandRunner } from "../../../bench/chat-ab/benchmark-command.js";

const writes = spyOn(process.stdout, "write");
afterEach(() => writes.mockClear());

function runner(output: string) {
  const exit = { code: 0, signal: null, statusOf: "payload" as const, ownership: "surrendered" as const };
  return benchmarkCommandRunner({
    spawnOwned: async () => ({
      pid: 1, token: "git", stdin: undefined,
      stdout: new Blob([output]).stream(), stderr: new Blob([]).stream(),
      exited: Promise.resolve(exit), terminate: async () => exit,
    }),
  });
}

test("keeps git query output private after leading -C and -c options", async () => {
  const result = await runner("reference diff")(["git", "-C", "/scratch/repo", "-c", "core.pager=cat", "show", "HEAD"]);
  expect(result.stdout).toBe("reference diff");
  expect(writes).not.toHaveBeenCalled();
});

test("mirrors other command output to stdout", async () => {
  await runner("installed")(["bun", "install"]);
  expect(writes).toHaveBeenCalled();
});
