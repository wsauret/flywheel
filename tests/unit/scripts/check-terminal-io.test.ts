import { describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { findTerminalIoViolations } from "../../../scripts/check-terminal-io.js";
import { temporaryDirectories } from "../../helpers/directories.js";

const temporaryDirectory = temporaryDirectories();

function tmpRepo(): string {
  return temporaryDirectory("flywheel-terminal-io-");
}

function write(root: string, relPath: string, content: string): void {
  const file = join(root, relPath);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

describe("check-terminal-io", () => {
  it("flags inherited child process stdio anywhere in src", () => {
    const root = tmpRepo();
    write(root, "src/orchestration/bad.ts", "Bun.spawn(['x'], { stdout: 'ignore', stderr: 'inherit' })\n");
    expect(findTerminalIoViolations(root)).toEqual([
      {
        file: "src/orchestration/bad.ts",
        line: 1,
        rule: "no-inherited-stdio",
        snippet: "Bun.spawn(['x'], { stdout: 'ignore', stderr: 'inherit' })",
      },
    ]);
  });

  it("flags inherited stdio arrays", () => {
    const root = tmpRepo();
    write(root, "src/infra/bad.ts", "Bun.spawn(['x'], {\n  stdio: ['ignore', 'ignore', 'inherit'],\n})\n");
    expect(findTerminalIoViolations(root)).toEqual([
      {
        file: "src/infra/bad.ts",
        line: 2,
        rule: "no-inherited-stdio",
        snippet: "stdio: ['ignore', 'ignore', 'inherit'],",
      },
    ]);
  });

  it("flags spawn calls without explicit stderr or stdio", () => {
    const root = tmpRepo();
    write(root, "src/orchestration/bad.ts", "Bun.spawn(['x'], { stdout: 'ignore' })\n");
    expect(findTerminalIoViolations(root)).toEqual([
      {
        file: "src/orchestration/bad.ts",
        line: 1,
        rule: "no-implicit-inherited-stderr",
        snippet: "Bun.spawn(['x'], { stdout: 'ignore' })",
      },
    ]);
  });

  it("permits spawn calls with explicit stderr", () => {
    const root = tmpRepo();
    write(root, "src/orchestration/good.ts", "Bun.spawn(['x'], { stdout: 'ignore', stderr: 'pipe' })\n");
    expect(findTerminalIoViolations(root)).toEqual([]);
  });

  it("flags direct terminal output outside CLI allowlisted files", () => {
    const root = tmpRepo();
    write(root, "src/orchestration/bad.ts", "console.error('boom')\n");
    write(root, "src/tui/bad.tsx", "process.stderr.write('boom')\n");
    expect(findTerminalIoViolations(root)).toEqual([
      {
        file: "src/orchestration/bad.ts",
        line: 1,
        rule: "no-terminal-output",
        snippet: "console.error('boom')",
      },
      {
        file: "src/tui/bad.tsx",
        line: 1,
        rule: "no-terminal-output",
        snippet: "process.stderr.write('boom')",
      },
    ]);
  });

  it("permits CLI terminal output, in the composition root and in a module's cli home", () => {
    const root = tmpRepo();
    write(root, "src/cli/status.ts", "console.log('ok')\n");
    write(root, "src/orchestration/modules/probe/cli/status.ts", "console.log('ok')\n");
    expect(findTerminalIoViolations(root)).toEqual([]);
  });

  it("permits known TUI stdout terminal-control writes", () => {
    const root = tmpRepo();
    write(root, "src/tui/components/error-boundary.tsx", "process.stdout.write('\\x1b[2J')\n");
    write(root, "src/tui/utils/clipboard.ts", "process.stdout.write('\\x1b]52;c;abc\\x07')\n");
    expect(findTerminalIoViolations(root)).toEqual([]);
  });
});
