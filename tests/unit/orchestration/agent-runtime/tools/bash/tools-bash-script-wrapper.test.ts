/** The script the bash tool writes before it launches anything.
 *
 *  The wrapper is a pure function of the platform it is built for, so every case
 *  here names the platform it is about and holds on any host. Bash sends both
 *  streams to a log that only this account can read; PowerShell writes text
 *  output as UTF-8. tools-bash-windows.test.ts owns how PowerShell records each
 *  stream and carries a native exit code. */

import { beforeAll, describe, expect, it } from "bun:test";

import { createBashDefinition } from "../../../../../../src/orchestration/agent-runtime/tools/bash/bash.js";
import { loadBashParser } from "../../../../../../src/orchestration/agent-runtime/tools/bash/policy/bash-parser.js";
import { bashExecution, makeMockOps, ownedSpawnProbe } from "./_bash-fixtures.js";
import { backgroundLogPath } from "../../../../../helpers/background-log-path.js";
import { makeContext } from "../_fixtures.js";

beforeAll(async () => {
  await loadBashParser();
});

/** A definition for `platform` that records the script it would have run. */
function recordingDefinition(platform: NodeJS.Platform) {
  const recorded = { script: "" };
  const def = createBashDefinition({
    ...bashExecution(),
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

function context() {
  return makeContext({ executionCwd: "/scratch", spawnOwned: ownedSpawnProbe().spawnOwned });
}

describe("bash tool: managed command script", () => {
  it("creates a private log, records every stream in it, and keeps heredoc delimiters on their own line", async () => {
    const { def, recorded } = recordingDefinition("linux");

    const result = await def.execute({ command: "python3 << 'EOF'\nprint('ok')\nEOF" }, context());

    expect(result.outcome).toBe("ok");
    const log = backgroundLogPath(recorded.script);
    if (!log) throw new Error("the script names its log");
    expect(recorded.script).toBe(`(umask 077 && : >'${log}')\nexec >'${log}' 2>&1\npython3 << 'EOF'\nprint('ok')\nEOF`);
  });

  it("writes PowerShell text output as UTF-8", async () => {
    const { def, recorded } = recordingDefinition("win32");

    const result = await def.execute({ command: "echo hi" }, context());

    expect(result.outcome).toBe("ok");
    expect(recorded.script).toStartWith("$ErrorActionPreference = 'Continue'\n$PSDefaultParameterValues['Out-File:Encoding'] = 'utf8'\n");
  });
});
