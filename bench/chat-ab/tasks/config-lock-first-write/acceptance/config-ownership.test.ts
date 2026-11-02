import { expect, test } from "bun:test";
import { join } from "node:path";
import { withConfigOwnership, withConfigOwnershipBlocking } from "../src/orchestration/config/config-file.js";
import { temporaryDirectories } from "../tests/helpers/directories.js";

const temporaryDirectory = temporaryDirectories();

test("an asynchronous config read does not block the next synchronous settings write", async () => {
  const location = { configPath: join(temporaryDirectory("config-ownership-"), "flywheel.toml") };
  const reading = withConfigOwnership(location, (config) => config.readText());
  try {
    withConfigOwnershipBlocking(location, (config) => {
      expect(config.write('[roles.explorer]\nmodel = "gpt-5.5"\neffort = "high"\n')).toBeUndefined();
    });
    expect(await reading).toBe("");
    expect(withConfigOwnershipBlocking(location, (config) => config.readText())).toBe('[roles.explorer]\nmodel = "gpt-5.5"\neffort = "high"\n');
  } finally {
    await reading;
  }
});

test("a failed config callback releases ownership before a sibling write", async () => {
  const location = { configPath: join(temporaryDirectory("config-ownership-"), "flywheel.toml") };
  const failure = new Error("config callback failed");
  const failed = withConfigOwnership(location, () => { throw failure; });
  const rejection = expect(failed).rejects.toBe(failure);
  withConfigOwnershipBlocking(location, (config) => {
    expect(config.write("show_thinking = true\n")).toBeUndefined();
  });
  await rejection;
  expect(withConfigOwnershipBlocking(location, (config) => config.readText())).toBe("show_thinking = true\n");
});
