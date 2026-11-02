import { describe, expect, it } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { findOwnedProcessLaunchViolations, type OwnedProcessViolation } from "../../../scripts/check-owned-process-launches.js";
import { temporaryDirectories } from "../../helpers/directories.js";

const temporaryDirectory = temporaryDirectories();

async function withRepo(build: (write: (relPath: string, content: string) => void, root: string) => void): Promise<OwnedProcessViolation[]> {
  const root = temporaryDirectory("flywheel-owned-launch-");
  build((relPath, content) => {
    const file = join(root, relPath);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  }, root);
  return await findOwnedProcessLaunchViolations(root);
}

function rules(violations: readonly OwnedProcessViolation[]): string[] {
  return violations.map((violation) => `${violation.file}:${violation.line} ${violation.rule}`);
}

describe("check-owned-process-launches", () => {
  it("accepts the owned boundary, Workers, and the exec-only shell entry", async () => {
    const violations = await withRepo((write) => {
      write("src/orchestration/tools/bash.ts", [
        "import { spawnOwned } from \"../../infra/owned-subprocess.js\"",
        "import { runOwnedCommand } from \"../../infra/owned-command.js\"",
        "import { openExternalUrl } from \"../../infra/open-external-url.js\"",
        "export const run = async () => {",
        "  const worker = new Worker(url)",
        "  await runOwnedCommand(scope, [\"git\", \"status\"])",
        "  await openExternalUrl(scope, \"https://example.com\")",
        "  return spawnOwned(scope, [\"rg\", \"pattern\"])",
        "}",
      ].join("\n"));
      write("bin/flywheel", "#!/bin/sh\nset -e\nexec bun --conditions=browser \"$dir/../scripts/dev.ts\" \"$@\"\n");
      write("scripts/dev.ts", "const { runFlywheelCli } = await import(\"../src/cli/index.js\")\nawait runFlywheelCli()\n");
    });

    expect(violations).toEqual([]);
  });

  it("requires every raw launch to state what it does about a console", async () => {
    // Windows gives a console program a fresh, visible console when its parent
    // holds none, which is every Flywheel not started from a terminal. A launch
    // that says nothing about it flashes a window at the user.
    const violations = await withRepo((write) => {
      write("src/infra/process-supervisor.ts", [
        "const quiet = Bun.spawn({ cmd: [\"a\"], windowsHide: true })",
        "const shorthand = Bun.spawnSync([\"b\"], { windowsHide })",
        "const loud = Bun.spawn({ cmd: [\"c\"], detached: true })",
        "const alsoLoud = Bun.spawnSync([\"d\"], { stdout: \"pipe\" })",
        "export const started = [quiet, shorthand, loud, alsoLoud].length",
      ].join("\n"));
    });

    expect(rules(violations)).toEqual([
      "src/infra/process-supervisor.ts:3 no-unstated-console",
      "src/infra/process-supervisor.ts:4 no-unstated-console",
    ]);
  });

  it("accepts domain methods that share a launcher name but carry no launch provenance", async () => {
    const violations = await withRepo((write) => {
      write("src/orchestration/domain.ts", [
        "import { registry } from \"./registry.js\"",
        "export const run = (jobs: JobPool) => {",
        "  jobs.spawn(\"worker\")",
        "  registry.execFile(descriptor)",
        "  return registry.execFileSync(descriptor)",
        "}",
      ].join("\n"));
    });

    expect(violations).toEqual([]);
  });

  it("rejects a Bun alias reached by a computed key", async () => {
    const violations = await withRepo((write) => {
      write("src/infra/alias.ts", "const runtime = Bun\nconst launcher = runtime[key]\nruntime.spawn([\"git\"])\n");
    });

    expect(violations).toEqual([
      { file: "src/infra/alias.ts", line: 2, rule: "no-raw-launch", detail: "runtime.[...]" },
      { file: "src/infra/alias.ts", line: 3, rule: "no-raw-launch", detail: "runtime.spawn" },
    ]);
  });

  it("rejects an object rest that takes the whole Bun namespace", async () => {
    const violations = await withRepo((write) => {
      write("src/infra/rest.ts", "const { version, ...rest } = Bun\nrest.spawn([\"git\"])\n");
    });

    expect(violations).toEqual([
      { file: "src/infra/rest.ts", line: 1, rule: "no-raw-launch", detail: "{ ... } = Bun" },
      { file: "src/infra/rest.ts", line: 2, rule: "no-raw-launch", detail: "rest.spawn" },
    ]);
  });

  it("fails closed on a module namespace whose specifier it cannot read", async () => {
    const violations = await withRepo((write) => {
      write("src/infra/a.ts", "const mod = await import(specifier)\nmod.spawn([\"git\"])\n");
      write("src/infra/b.ts", "const { execFile } = await import(specifier)\n");
      write("src/infra/c.ts", "const { default: wasm } = await import(specifier, { with: { type: \"wasm\" } })\nuse(wasm)\n");
    });

    expect(violations).toEqual([
      { file: "src/infra/a.ts", line: 1, rule: "unclassifiable-module-load", detail: "import(...)" },
      { file: "src/infra/a.ts", line: 2, rule: "no-raw-launch", detail: "mod.spawn" },
      { file: "src/infra/b.ts", line: 1, rule: "no-raw-launch", detail: "{ execFile } = import(...)" },
      { file: "src/infra/b.ts", line: 1, rule: "unclassifiable-module-load", detail: "import(...)" },
    ]);
  });

  it("classifies a specifier-forwarding loader at its call sites and fails closed on the rest", async () => {
    const violations = await withRepo((write) => {
      write("src/infra/a.ts", "const load = (name: string) => import(name)\nconst cp = await load(\"node:child_process\")\n");
      write("src/infra/b.ts", "const load = (name: string) => import(name)\nconst mod = await load(chosen)\nmod.spawn([\"git\"])\n");
      write("src/infra/c.ts", "const cp = require(chosen)\n");
      write("src/infra/d.ts", "function load(name) { return import(name) }\nconst pty = await load(\"node-pty\")\npty.spawn(\"sh\")\n");
    });

    expect(violations).toEqual([
      { file: "src/infra/a.ts", line: 2, rule: "no-node-child-process", detail: 'import "node:child_process"' },
      { file: "src/infra/b.ts", line: 2, rule: "unclassifiable-module-load", detail: "load(...)" },
      { file: "src/infra/b.ts", line: 3, rule: "no-raw-launch", detail: "mod.spawn" },
      { file: "src/infra/c.ts", line: 1, rule: "unclassifiable-module-load", detail: "require(...)" },
      { file: "src/infra/d.ts", line: 3, rule: "no-raw-launch", detail: "pty.spawn" },
    ]);
  });

  it("classifies a module load asked for by a path this file built, and fails closed on the rest", async () => {
    const violations = await withRepo((write) => {
      write("src/infra/a.ts", "const require = createRequire(import.meta.url)\nconst addon = require(resolve(dir, name))\naddon.grep(pattern)\n");
      write("src/infra/b.ts", "const entry = join(dir, \"sharp.node\")\nconst mod = createRequire(entry)(entry)\nmod.spawn([\"git\"])\n");
      write("src/infra/c.ts", "const candidates = [resolve(a), resolve(b)]\nfor (const candidate of candidates) require(candidate)\n");
      write("src/infra/d.ts", "const mod = require(name)\n");
    });

    expect(violations).toEqual([
      { file: "src/infra/b.ts", line: 3, rule: "no-raw-launch", detail: "mod.spawn" },
      { file: "src/infra/d.ts", line: 1, rule: "unclassifiable-module-load", detail: "require(...)" },
    ]);
  });

  it("rejects a builtin module reached through getBuiltinModule or createRequire, however it is aliased", async () => {
    const violations = await withRepo((write) => {
      write("src/infra/a.ts", "const cp = process.getBuiltinModule(\"node:child_process\")\n");
      write("src/infra/b.ts", "import { createRequire } from \"node:module\"\nconst req = createRequire(import.meta.url)\nconst cp = req(\"child_process\")\n");
      write("src/infra/c.ts", "const { getBuiltinModule } = process\nconst cp = getBuiltinModule(\"node:child_process\")\n");
      write("src/infra/d.ts", "createRequire(import.meta.url)(\"child_process\")\n");
      write("src/infra/e.ts", "const pty = process.getBuiltinModule(\"node-pty\")\npty.spawn(\"sh\")\n");
    });

    expect(rules(violations)).toEqual([
      "src/infra/a.ts:1 no-node-child-process",
      "src/infra/b.ts:3 no-node-child-process",
      "src/infra/c.ts:2 no-node-child-process",
      "src/infra/d.ts:1 no-node-child-process",
      "src/infra/e.ts:2 no-raw-launch",
    ]);
  });

  it("rejects an authority module that exports a raw launcher under any name", async () => {
    const violations = await withRepo((write) => {
      write("src/infra/process-container.ts", [
        "const { spawn } = Bun",
        "export { spawn as launchContainer }",
        "export const containerLauncher = Bun.spawnSync",
        "export default Bun.spawn",
      ].join("\n"));
      write("src/infra/process-supervisor.ts", "export { spawn } from \"node:child_process\"\n");
      write("src/orchestration/user.ts", "import { launchContainer } from \"../infra/process-container.js\"\nlaunchContainer([\"git\"])\n");
    });

    expect(violations).toEqual([
      { file: "src/infra/process-container.ts", line: 2, rule: "no-exported-raw-launch", detail: "export spawn" },
      { file: "src/infra/process-container.ts", line: 3, rule: "no-exported-raw-launch", detail: "export containerLauncher" },
      { file: "src/infra/process-container.ts", line: 4, rule: "no-exported-raw-launch", detail: "export default" },
      { file: "src/infra/process-supervisor.ts", line: 1, rule: "no-node-child-process", detail: 'import "node:child_process"' },
    ]);
  });

  it("tracks a package default import as a capability carrier, and a local default as an ordinary value", async () => {
    const violations = await withRepo((write) => {
      write("src/infra/a.ts", "import pty from \"node-pty\"\npty.spawn(\"sh\")\n");
      write("src/infra/b.ts", "import settings from \"./settings.js\"\nsettings.spawn(\"worker\")\n");
      write("src/infra/c.ts", "import client from \"some-sdk\"\nclient.connect(url)\n");
    });

    expect(violations).toEqual([
      { file: "src/infra/a.ts", line: 2, rule: "no-raw-launch", detail: "pty.spawn" },
    ]);
  });

  it("tracks a launcher taken from a package namespace but not from a module of this repository", async () => {
    const violations = await withRepo((write) => {
      write("src/infra/a.ts", "import * as pty from \"node-pty\"\npty.spawn(\"sh\")\n");
      write("src/infra/b.ts", "import * as bun from \"bun\"\nbun.spawn([\"git\"])\n");
      write("src/infra/c.ts", "const helper = await import(\"./helper.js\")\nhelper.spawn(\"sh\")\n");
    });

    expect(rules(violations)).toEqual([
      "src/infra/a.ts:2 no-raw-launch",
      "src/infra/b.ts:2 no-raw-launch",
    ]);
  });

  it("scans every executable production extension and skips declaration files", async () => {
    const violations = await withRepo((write) => {
      write("src/infra/a.js", "Bun.spawn([\"git\"])\n");
      write("src/infra/b.mjs", "Bun.spawn([\"git\"])\n");
      write("src/infra/c.cjs", "Bun.spawn([\"git\"])\n");
      write("src/infra/d.mts", "Bun.spawn([\"git\"])\n");
      write("src/infra/e.cts", "Bun.spawn([\"git\"])\n");
      write("src/tui/f.jsx", "export const View = () => <text>don't</text>\nBun.spawn([\"git\"])\n");
      write("src/infra/g.d.ts", "export declare const spawn: typeof Bun.spawn\n");
    });

    expect(rules(violations)).toEqual([
      "src/infra/a.js:1 no-raw-launch",
      "src/infra/b.mjs:1 no-raw-launch",
      "src/infra/c.cjs:1 no-raw-launch",
      "src/infra/d.mts:1 no-raw-launch",
      "src/infra/e.cts:1 no-raw-launch",
      "src/tui/f.jsx:2 no-raw-launch",
    ]);
  });

  it("rejects a direct Bun launch outside the raw-launch authority modules", async () => {
    const violations = await withRepo((write) => {
      write("src/orchestration/bad.ts", "const proc = Bun.spawn([\"git\"])\nconst out = Bun.spawnSync([\"git\"])\n");
    });

    expect(violations).toEqual([
      { file: "src/orchestration/bad.ts", line: 1, rule: "no-raw-launch", detail: "Bun.spawn" },
      { file: "src/orchestration/bad.ts", line: 2, rule: "no-raw-launch", detail: "Bun.spawnSync" },
    ]);
  });

  it("permits raw launches only inside the reviewed authority modules", async () => {
    const violations = await withRepo((write) => {
      // Every raw launch also states what it does about a console, which is
      // what `no-unstated-console` requires of exactly these modules.
      write("src/infra/owned-subprocess-backend.ts", "Bun.spawn({ cmd, windowsHide: true })\n");
      write("src/infra/process-container.ts", "Bun.spawnSync([\"ps\"], { windowsHide: true })\n");
      write("src/infra/owned-command-supervisor.ts", "Bun.spawn({ cmd, windowsHide: true })\n");
      write("src/infra/process-supervisor.ts", "Bun.spawn({ cmd, detached: true, windowsHide: true })\n");
      write("src/infra/persistent-subprocess.ts", "Bun.spawn({ cmd, detached: true, windowsHide: true })\n");
    });

    expect(violations).toEqual([]);
  });

  it("rejects imports of the persistent raw launch authority outside authority modules", async () => {
    const violations = await withRepo((write) => {
      write("src/orchestration/bad.ts", "import { persistentSubprocessPlatform } from \"../infra/persistent-subprocess.js\"\n");
    });

    expect(rules(violations)).toEqual(["src/orchestration/bad.ts:1 no-raw-backend-symbol"]);
  });

  it("rejects aliased and destructured Bun launchers", async () => {
    const violations = await withRepo((write) => {
      write("src/infra/alias.ts", "const { spawn, spawnSync } = Bun\nconst host = { spawn }\nhost.spawn([\"git\"])\n");
    });

    expect(rules(violations)).toEqual([
      "src/infra/alias.ts:1 no-raw-launch",
      "src/infra/alias.ts:1 no-raw-launch",
      "src/infra/alias.ts:3 no-raw-launch",
    ]);
  });

  it("rejects a launcher renamed out of Bun by a destructuring key", async () => {
    const violations = await withRepo((write) => {
      write("src/infra/rename.ts", "const { spawn: start } = Bun\nstart([\"git\"])\n");
    });

    expect(violations).toEqual([
      { file: "src/infra/rename.ts", line: 1, rule: "no-raw-launch", detail: "{ spawn } = Bun" },
    ]);
  });

  it("rejects a launcher reached by a computed or reflected property", async () => {
    const violations = await withRepo((write) => {
      write("src/infra/a.ts", "Bun[\"spawn\"]([\"git\"])\n");
      write("src/infra/b.ts", "const get = Reflect.get(Bun, \"spawn\")\nget([\"git\"])\n");
      write("src/infra/c.ts", "const key = pick()\nBun[key]([\"git\"])\n");
    });

    expect(violations).toEqual([
      { file: "src/infra/a.ts", line: 1, rule: "no-raw-launch", detail: "Bun.spawn" },
      { file: "src/infra/b.ts", line: 1, rule: "no-raw-launch", detail: "Bun.spawn" },
      { file: "src/infra/c.ts", line: 2, rule: "no-raw-launch", detail: "Bun.[...]" },
    ]);
  });

  it("rejects Node child-process imports, requires, and dynamic imports", async () => {
    const violations = await withRepo((write) => {
      write("src/infra/a.ts", "import { spawn } from \"node:child_process\"\n");
      write("src/infra/b.ts", "const cp = require(\"child_process\")\n");
      write("src/infra/c.ts", "const cp = await import(\"node:child_process\")\n");
      write("src/infra/d.ts", "import * as cp from \"child_process\"\n");
      write("src/infra/e.ts", "const { spawn } = await import(\"child_process\")\n");
    });

    expect(rules(violations)).toEqual([
      "src/infra/a.ts:1 no-node-child-process",
      "src/infra/b.ts:1 no-node-child-process",
      "src/infra/c.ts:1 no-node-child-process",
      "src/infra/d.ts:1 no-node-child-process",
      "src/infra/e.ts:1 no-node-child-process",
    ]);
  });

  it("rejects Deno commands, Bun shells, and globalThis escapes", async () => {
    const violations = await withRepo((write) => {
      write("src/infra/a.ts", "const cmd = new Deno.Command(\"git\")\n");
      write("src/infra/b.ts", "await Bun.$`git status`\n");
      write("src/infra/c.ts", "import { $ } from \"bun\"\nawait $`git status`\n");
      write("src/infra/d.ts", "globalThis.Bun.spawn([\"git\"])\nglobalThis[\"Bun\"].spawn([\"git\"])\n");
    });

    expect(rules(violations)).toEqual([
      "src/infra/a.ts:1 no-raw-launch",
      "src/infra/b.ts:1 no-shell-wrapper",
      "src/infra/c.ts:1 no-shell-wrapper",
      "src/infra/d.ts:1 no-global-escape",
      "src/infra/d.ts:1 no-raw-launch",
      "src/infra/d.ts:2 no-global-escape",
      "src/infra/d.ts:2 no-raw-launch",
    ]);
  });

  it("rejects raw backend symbols imported outside the authority modules", async () => {
    const violations = await withRepo((write) => {
      write("src/orchestration/bad.ts", "import { createOwnedProcessBackend } from \"../infra/owned-subprocess-backend.js\"\n");
      write("src/orchestration/worse.ts", "import { unixContainer, ownUnixContainer } from \"../infra/process-container.js\"\n");
      // The probe and the Windows tree read the kernel and end processes
      // through it; neither builds a launcher.
      write("src/orchestration/fine.ts", "import { windowsContainer, bunContainerProbe } from \"../infra/process-container.js\"\n");
    });

    expect(rules(violations)).toEqual([
      "src/orchestration/bad.ts:1 no-raw-backend-symbol",
      "src/orchestration/worse.ts:1 no-raw-backend-symbol",
      "src/orchestration/worse.ts:1 no-raw-backend-symbol",
    ]);
  });

  it("rejects a whole authority namespace however it is taken", async () => {
    const violations = await withRepo((write) => {
      write("src/orchestration/a.ts", "import * as backend from \"../infra/owned-subprocess-backend.js\"\n");
      write("src/orchestration/b.ts", "const all = await import(\"../infra/process-supervisor.js\")\n");
    });

    expect(violations).toEqual([
      { file: "src/orchestration/a.ts", line: 1, rule: "no-raw-backend-symbol", detail: "import * from \"../infra/owned-subprocess-backend.js\"" },
      { file: "src/orchestration/b.ts", line: 1, rule: "no-raw-backend-symbol", detail: "import * from \"../infra/process-supervisor.js\"" },
    ]);
  });

  it("permits the settlement and probe symbols the guardian and watchdog own", async () => {
    const violations = await withRepo((write) => {
      write("src/infra/process-guardian.ts", [
        "import { ownedProcessBackend } from \"./owned-subprocess-backend.js\"",
        "import { emptyContainers, type ManagedContainer } from \"./process-container.js\"",
        "export const inspect = (pid: number) => ownedProcessBackend.inspect(pid)",
      ].join("\n"));
      write("src/infra/process-watchdog.ts", "import { threadProcessProbeSource, type ThreadProcessProbe } from \"./owned-subprocess-backend.js\"\n");
      write("src/tui/app.tsx", "import type { LauncherScope } from \"../infra/process-supervisor.js\"\n");
      write("src/cli/index.ts", "const { runCommandSupervisorMain } = await import(\"../infra/owned-command-supervisor.js\")\n");
    });

    expect(violations).toEqual([]);
  });

  it("fails closed on syntax that hides the rest of the file", async () => {
    const violations = await withRepo((write) => {
      write("src/infra/a.ts", "/* never closed\nBun.spawn([\"git\"])\n");
      write("src/infra/b.ts", "const t = `open\nBun.spawn([\"git\"])\n");
    });

    expect(rules(violations)).toEqual([
      "src/infra/a.ts:1 unclassifiable-source",
      "src/infra/a.ts:2 no-raw-launch",
      "src/infra/b.ts:1 unclassifiable-source",
      "src/infra/b.ts:2 no-raw-launch",
    ]);
  });

  it("rejects detached and non-exec child launches in the shell entry", async () => {
    const violations = await withRepo((write) => {
      write("bin/flywheel", "#!/bin/sh\nnohup bun scripts/dev.ts &\nbun scripts/dev.ts\n");
    });

    expect(rules(violations)).toEqual([
      "bin/flywheel:2 no-detached-shell-launch",
      "bin/flywheel:3 no-shell-child-launch",
    ]);
  });

  it("scans every shipped directory, whatever it is named", async () => {
    const violations = await withRepo((write) => {
      write("src/infra/fixtures/rogue.ts", "Bun.spawn([\"git\"])\n");
      write("src/infra/generated/rogue.ts", "Bun.spawn([\"git\"])\n");
      write("src/infra/vendor/rogue.ts", "Bun.spawn([\"git\"])\n");
    });

    expect(rules(violations)).toEqual([
      "src/infra/fixtures/rogue.ts:1 no-raw-launch",
      "src/infra/generated/rogue.ts:1 no-raw-launch",
      "src/infra/vendor/rogue.ts:1 no-raw-launch",
    ]);
  });

  it("judges ownership in production roots only, and never follows a symlink out of the tree", async () => {
    const violations = await withRepo((write, root) => {
      write("src/infra/ok.ts", "export const ok = true\n");
      write("outside/rogue.ts", "Bun.spawn([\"git\"], { windowsHide: true })\n");
      write("tests/unit/rogue.ts", "Bun.spawn([\"git\"], { windowsHide: true })\n");
      write("src/node_modules/rogue.ts", "Bun.spawn([\"git\"])\n");
      symlinkSync(join(root, "outside"), join(root, "src/linked"));
    });

    // A launch under `tests` owns nothing and answers to no ownership rule; a
    // path outside the tree, and anything under `node_modules`, is not read at
    // all.
    expect(violations).toEqual([]);
  });

  it("judges the console of every launch this repository makes, wherever it lives", async () => {
    const violations = await withRepo((write) => {
      // An authority module may hold the raw launch, and stating its console keeps it clean.
      write("src/infra/process-supervisor.ts", "Bun.spawn([\"git\"], { windowsHide: true })\n");
      write("tests/unit/rogue.ts", "Bun.spawn([\"git\"])\n");
      write("scripts/rogue.ts", "Bun.spawnSync([\"git\"])\n");
      write("bench/rogue.ts", "Bun.spawn([\"git\"])\n");
      write("outside/rogue.ts", "Bun.spawn([\"git\"])\n");
      // Run output a benchmark or an end-to-end test wrote is not read.
      write("bench/chat-ab/results/run-1/workspace/rogue.ts", "Bun.spawn([\"git\"])\n");
      write("tests/e2e/results/rogue.ts", "Bun.spawn([\"git\"])\n");
    });

    // Windows gives a console program started by a console-less process a
    // window of its own, and a test or build script opens it on the same screen
    // production would have.
    expect(rules(violations)).toEqual([
      "bench/rogue.ts:1 no-unstated-console",
      "scripts/rogue.ts:1 no-unstated-console",
      "tests/unit/rogue.ts:1 no-unstated-console",
    ]);
  });
});
