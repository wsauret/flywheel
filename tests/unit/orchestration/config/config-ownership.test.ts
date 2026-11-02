import { expect, test, spyOn } from "bun:test";
import * as fs from "node:fs";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { ContainedDirectory } from "../../../../src/infra/descriptor-directory.js";
import { join } from "node:path";
import { withConfigOwnership, withConfigOwnershipBlocking, type ConfigReadResult } from "../../../../src/orchestration/config/config-file.js";
import { createRuntimeConfigOwner } from "../../../../src/orchestration/config/runtime-config-owner.js";
import { temporaryDirectories } from "../../../helpers/directories.js";
import { HOLDS_DIRECTORY_VALUES } from "../../../helpers/held-directory-values.js";

const temporaryDirectory = temporaryDirectories();

test("a config patch cannot overwrite an external edit after its admitted read", () => {
  const configPath = join(temporaryDirectory("config-cas-"), "flywheel.toml");
  writeFileSync(configPath, "show_thinking = true\n");
  withConfigOwnershipBlocking({ configPath }, (config) => {
    expect(config.readText()).toBe("show_thinking = true\n");
    writeFileSync(configPath, "theme = \"aura\"\n");
    expect(() => config.write("show_thinking = false\n")).toThrow();
  });
  expect(readFileSync(configPath, "utf8")).toBe("theme = \"aura\"\n");
});

test("contained publication refusal throws instead of reporting saved bytes", () => {
  const configPath = join(temporaryDirectory("config-refusal-"), "flywheel.toml");
  writeFileSync(configPath, "show_thinking = true\n");
  const publish = spyOn(ContainedDirectory.prototype, "publishFileBytesThrough").mockReturnValue({ status: "not_applied", error: new Error("publication refused") });
  try {
    withConfigOwnershipBlocking({ configPath }, (config) => {
      config.readText();
      expect(() => config.write("show_thinking = false\n")).toThrow();
    });
    expect(readFileSync(configPath, "utf8")).toBe("show_thinking = true\n");
  } finally {
    publish.mockRestore();
  }
});

test("indeterminate publication classifies one held reread candidate-first", () => {
  const candidate = "show_thinking = false\n";
  const warning = new Error("publication verification unavailable");
  for (const outcome of ["candidate", "prior", "absent", "other", "unreadable", "equal"] as const) {
    const configPath = join(temporaryDirectory("config-indeterminate-"), "flywheel.toml");
    const prior = outcome === "equal" ? candidate : "show_thinking = true\n";
    if (outcome !== "absent") writeFileSync(configPath, prior);
    const publish = spyOn(ContainedDirectory.prototype, "publishFileBytesThrough").mockImplementation(() => {
      if (outcome === "candidate") writeFileSync(configPath, candidate);
      if (outcome === "other") writeFileSync(configPath, "theme = \"aura\"\n");
      if (outcome === "unreadable") {
        rmSync(configPath);
        mkdirSync(configPath);
      }
      return { status: "indeterminate", error: warning };
    });
    try {
      withConfigOwnershipBlocking({ configPath }, (config) => {
        config.readText();
        if (outcome === "candidate" || outcome === "equal") {
          expect(config.write(candidate)).toBe(warning);
        } else {
          let failure: unknown;
          try { config.write(candidate); } catch (error) { failure = error; }
          expect(failure).toMatchObject({ outcome: outcome === "prior" || outcome === "absent" ? "not-applied" : "unknown" });
        }
      });
      expect(publish).toHaveBeenCalledTimes(1);
    } finally {
      publish.mockRestore();
    }
  }
});

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

test("a use-time observer takes ownership only when the published file changed", async () => {
  const configPath = join(temporaryDirectory("config-ownership-"), "flywheel.toml");
  writeFileSync(configPath, "show_thinking = true\n");
  let windows = 0;
  const owner = await createRuntimeConfigOwner({
    configPath,
    watch: false,
    withOwnership: async (location, use) => {
      windows += 1;
      return await withConfigOwnership(location, use);
    },
  });
  const observe = owner.useTimeObserver((read: ConfigReadResult) => read.kind === "text" ? read.text : read.kind);
  try {
    expect(await observe()).toBe("show_thinking = true\n");
    expect(await observe()).toBe("show_thinking = true\n");
    expect(windows).toBe(1);

    expect((await owner.mutate("showThinking", true, false)).ok).toBe(true);
    expect(windows).toBe(2);
    expect(await observe()).toContain("show_thinking = false");
    expect(await observe()).toContain("show_thinking = false");
    expect(windows).toBe(3);

    // A hand edit in place keeps the file but changes what it says.
    writeFileSync(configPath, "show_thinking = true\ntheme = \"midnight\"\n");
    expect(await observe()).toContain("midnight");
    expect(windows).toBe(4);

    // A missing file is never reused: on Windows a replacement in progress also reads as missing.
    rmSync(configPath);
    expect(await observe()).toBe("missing");
    expect(await observe()).toBe("missing");
    expect(windows).toBe(6);
  } finally {
    await owner.dispose();
  }
});

test("a use-time observer stats nothing while a confirmed watch holds the config identity", async () => {
  const directory = temporaryDirectory("config-ownership-");
  const configPath = join(directory, "flywheel.toml");
  writeFileSync(configPath, "show_thinking = true\n");
  const owner = await createRuntimeConfigOwner({ configPath, watch: true, watchOptions: { debounceMs: 1, revalidateMs: 5 } });
  const observe = owner.useTimeObserver((read: ConfigReadResult) => read.kind === "text" ? read.text : read.kind);
  const lstat = spyOn(fs, "lstatSync");
  try {
    // The watch confirms its hold at its first periodic revalidation. Where the platform holds nothing, every observation stats.
    if (HOLDS_DIRECTORY_VALUES) {
      for (let attempt = 0; ; attempt += 1) {
        expect(attempt).toBeLessThan(400);
        await Bun.sleep(5);
        await observe();
        lstat.mockClear();
        await observe();
        if (lstat.mock.calls.length === 0) break;
      }
    } else await Bun.sleep(25);
    lstat.mockClear();
    for (let request = 0; request < 20; request += 1) expect(await observe()).toBe("show_thinking = true\n");
    if (HOLDS_DIRECTORY_VALUES) expect(lstat).not.toHaveBeenCalled();
    else expect(lstat.mock.calls.length).toBeGreaterThanOrEqual(20);

    // A write in this process is seen by the next observation, before any watch event.
    expect((await owner.mutate("showThinking", true, false)).ok).toBe(true);
    expect(await observe()).toContain("show_thinking = false");
  } finally {
    lstat.mockRestore();
    await owner.dispose();
  }
});

test("a use-time observer never reuses a refused read", async () => {
  const configPath = join(temporaryDirectory("config-ownership-"), "flywheel.toml");
  writeFileSync(configPath, "show_thinking = true\n");
  let windows = 0;
  let refuse = true;
  const owner = await createRuntimeConfigOwner({
    configPath,
    watch: false,
    withOwnership: async (location, use) => {
      windows += 1;
      return await withConfigOwnership(location, (ownership) => {
        if (!refuse) return use(ownership);
        refuse = false;
        return use({ ...ownership, read: () => ({ kind: "failure", code: "refused-or-unreadable" }) });
      });
    },
  });
  const observe = owner.useTimeObserver((read: ConfigReadResult) => read.kind === "text" ? read.text : read.kind);
  try {
    expect(await observe()).toBe("failure");
    expect(await observe()).toBe("show_thinking = true\n");
    expect(windows).toBe(2);
    expect(await observe()).toBe("show_thinking = true\n");
    expect(windows).toBe(2);
  } finally {
    await owner.dispose();
  }
});
