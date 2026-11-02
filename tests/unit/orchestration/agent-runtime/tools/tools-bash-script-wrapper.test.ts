/** The script the bash tool writes before it launches anything.
 *
 *  The wrapper is a pure function of the platform it is built for, so every case
 *  here names the platform it is about and holds on any host. Each platform
 *  states its own promises: Bash merges stderr into recorded stdout and carries
 *  xtrace on a descriptor of its own, and PowerShell merges every stream and
 *  reports the exit code a native program left behind. */

import { beforeAll, describe, expect, it } from "bun:test";

import { createBashDefinition } from "../../../../../src/orchestration/agent-runtime/tools/bash.js";
import { loadBashParser } from "../../../../../src/orchestration/agent-runtime/tools/bash-parser.js";
import { makeMockOps, ownedSpawnProbe } from "./_bash-fixtures.js";
import { makeContext } from "./_fixtures.js";

beforeAll(async () => {
  await loadBashParser();
});

/** A definition for `platform` that records the script it would have run. */
function recordingDefinition(platform: NodeJS.Platform) {
  const recorded = { script: "" };
  const def = createBashDefinition({
    platform,
    operations: makeMockOps({
      writeScript: async (_path, content) => {
        recorded.script = content;
        return content.length;
      },
    }),
  });
  return { def, recorded };
}

function context(overrides: { onExecutionOutput?: () => void } = {}) {
  return makeContext({ executionCwd: "/scratch", spawnOwned: ownedSpawnProbe().spawnOwned, ...overrides });
}

describe("bash tool: foreground script wrapper", () => {
  it("keeps heredoc delimiters on their own line", async () => {
    const { def, recorded } = recordingDefinition("linux");

    const result = await def.execute({ command: "python3 << 'EOF'\nprint('ok')\nEOF" }, context());

    expect(result.outcome).toBe("ok");
    expect(recorded.script).toBe("exec 2>&1\npython3 << 'EOF'\nprint('ok')\nEOF");
  });

  it("omits the xtrace channel when no live output consumer exists", async () => {
    const { def, recorded } = recordingDefinition("linux");

    await def.execute({ command: "echo hi" }, context());
    expect(recorded.script).not.toContain("exec 9>&2");
    expect(recorded.script).not.toContain("set -x");

    await def.execute({ command: "echo hi" }, context({ onExecutionOutput: () => {} }));
    expect(recorded.script).toContain("exec 9>&2");
    expect(recorded.script).toContain("BASH_XTRACEFD=9");
  });

  it("wraps a Windows command so every stream is recorded and the native exit code is carried", async () => {
    const { def, recorded } = recordingDefinition("win32");

    const result = await def.execute({ command: "echo hi" }, context({ onExecutionOutput: () => {} }));

    expect(result.outcome).toBe("ok");
    expect(recorded.script).toBe([
      "$ErrorActionPreference = 'Continue'",
      "$PSDefaultParameterValues['Out-File:Encoding'] = 'utf8'",
      "& {",
      "echo hi",
      "} *>&1",
      "$success = $?",
      "$nativeExitCode = $global:LASTEXITCODE",
      "if ($nativeExitCode -ne $null) { exit $nativeExitCode }",
      "if ($success) { exit 0 }",
      "exit 1",
    ].join("\n"));
    // Windows carries no xtrace channel, and asking for live output above proves
    // it is not the consumer that would have added one.
    expect(recorded.script).not.toContain("exec 9>&2");
    expect(recorded.script).not.toContain("set -x");
  });
});
