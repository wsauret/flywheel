import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildTokenizer,
  TOKENIZER_FINGERPRINT,
  TOKENIZER_RUSTC_COMMIT,
  TOKENIZER_RUSTFLAGS,
  TOKENIZER_TARGET,
  TOKENIZER_TOOLCHAIN,
  tokenizerSourceSha256,
  type TokenizerBuildEnvironment,
} from "../../../scripts/build-tokenizer.js";

async function fixture(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "flywheel-tokenizer-"));
  try {
    const crate = join(root, "crates", "tokenizer");
    await mkdir(join(crate, "src"), { recursive: true });
    await writeFile(join(crate, "Cargo.toml"), "[package]\nname='flywheel-tokenizer'\nversion='0.0.0'\n");
    await mkdir(join(root, "scripts"), { recursive: true });
    await writeFile(join(root, "scripts", "build-tokenizer.ts"), "original build recipe");
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("tokenizer build", () => {
  test("binds the build recipe into the source fingerprint", async () => {
    await fixture(async (root) => {
      const before = await tokenizerSourceSha256(root);
      await writeFile(join(root, "scripts", "build-tokenizer.ts"), "changed build recipe");
      expect(await tokenizerSourceSha256(root)).not.toBe(before);
    });
  });

  test("verifies the committed five-encoding fixture contract offline", async () => {
    const root = join(import.meta.dir, "..", "..", "..");
    let commands = 0;
    let writes = 0;

    await buildTokenizer({
      root,
      verify: true,
      run: async () => {
        commands += 1;
        throw new Error("must not run");
      },
      onTrackedWrite: () => {
        writes += 1;
      },
    });

    const fingerprint = JSON.parse(await readFile(join(root, TOKENIZER_FINGERPRINT), "utf8"));
    expect(fingerprint).toMatchObject({
      version: 2,
      toolchain: TOKENIZER_TOOLCHAIN,
      target: TOKENIZER_TARGET,
      rustcCommit: TOKENIZER_RUSTC_COMMIT,
      upstream: { revision: "a1b254047d12e143b7c6011536e918c6c35c5906" },
      ctok: { revision: "df3b59b5e645289a5eadc8e24036b99d39c333c4" },
      fixtureInventory: {
        corpus: { rows: 6, checks: 30 },
        claude: { rows: 493, checks: 1_479, offsets: { ClaudeV3: 7, ClaudeV47: 11, ClaudeV5: 6 } },
        sonnet: { rows: 63, checks: 63, offset: 6 },
        totalChecks: 1_572,
      },
    });
    expect(commands).toBe(0);
    expect(writes).toBe(0);
  });

  test.each(["toolchain", "lookup", "version"] as const)("fails %s prerequisites before tracked output mutation", async (failure) => {
    await fixture(async (root) => {
      let writes = 0;
      const rustc = "C:\\pinned toolchain\\bin\\rustc.exe";
      const commands: Array<readonly string[]> = [];
      await expect(buildTokenizer({
        root,
        run: async (argv) => {
          commands.push(argv);
          if (argv[1] === "toolchain") return { exitCode: 0, stdout: failure === "toolchain" ? "stable\n" : TOKENIZER_TOOLCHAIN };
          if (argv[1] === "target") return { exitCode: 0, stdout: TOKENIZER_TARGET };
          if (argv[1] === "which") return failure === "lookup"
            ? { exitCode: 1, stdout: "", stderr: "compiler unavailable" }
            : { exitCode: 0, stdout: `${rustc}\r\n` };
          return { exitCode: 0, stdout: "wrong compiler commit" };
        },
        onTrackedWrite: () => { writes += 1; },
      })).rejects.toThrow(failure === "toolchain" ? TOKENIZER_TOOLCHAIN : failure === "lookup" ? "Tokenizer compiler lookup failed: compiler unavailable" : TOKENIZER_RUSTC_COMMIT);
      expect(writes).toBe(0);
      expect(commands.some((argv) => argv.includes("cargo"))).toBe(false);
    });
  });

  test("builds with the verified pinned compiler and remapped paths without publishing a failed build", async () => {
    await fixture(async (root) => {
      const environments: Array<TokenizerBuildEnvironment | undefined> = [];
      const commands: Array<readonly string[]> = [];
      const rustc = "C:\\pinned toolchain\\bin\\rustc.exe";
      let writes = 0;
      await expect(buildTokenizer({
        root,
        run: async (argv, _cwd, environment) => {
          environments.push(environment);
          commands.push(argv);
          if (argv[1] === "toolchain") return { exitCode: 0, stdout: TOKENIZER_TOOLCHAIN };
          if (argv[1] === "target") return { exitCode: 0, stdout: TOKENIZER_TARGET };
          if (argv[1] === "which") return { exitCode: 0, stdout: `${rustc}\r\n` };
          if (argv[0] === rustc) return { exitCode: 0, stdout: TOKENIZER_RUSTC_COMMIT };
          return { exitCode: 1, stdout: "", stderr: "expected stop" };
        },
        onTrackedWrite: () => { writes += 1; },
      })).rejects.toThrow("Tokenizer Cargo build failed: expected stop");
      expect(commands[2]).toEqual(["rustup", "which", "--toolchain", TOKENIZER_TOOLCHAIN, "rustc"]);
      expect(commands[3]).toEqual([rustc, "--version", "--verbose"]);
      expect(commands.at(-1)?.slice(0, 9)).toEqual(["rustup", "run", TOKENIZER_TOOLCHAIN, "cargo", "build", "--release", "--locked", "--target", TOKENIZER_TARGET]);
      expect(environments.at(-1)).toEqual({ RUSTC: rustc, RUSTFLAGS: TOKENIZER_RUSTFLAGS });
      expect(writes).toBe(0);
    });
  });
});
