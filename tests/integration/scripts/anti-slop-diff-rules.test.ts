import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runDiffRules, type RunOptions } from "../../../scripts/anti-slop-llm/diff-rules/runner.ts";
import { temporaryDirectories } from "../../helpers/directories.js";
import { startMockDecisionModels, type MockDecisionModels } from "../../helpers/mock-decision-models.js";

const temporaryDirectory = temporaryDirectories();

let mock: MockDecisionModels | undefined;
afterEach(() => {
  mock?.stop();
  mock = undefined;
});

function startMock(): MockDecisionModels {
  mock = startMockDecisionModels();
  return mock;
}

function git(cwd: string, args: readonly string[]): void {
  const result = Bun.spawnSync(["git", "-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
  });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
}

/** A repository whose `feature` branch changes one file against `main`. */
function repositoryWithChange(): string {
  const dir = temporaryDirectory("fw-diff-rules-");
  git(dir, ["init", "--quiet", "--initial-branch=main"]);
  writeFileSync(join(dir, "math.ts"), "export const add = (left: number, right: number): number => left + right;\n");
  git(dir, ["add", "."]);
  git(dir, ["commit", "--quiet", "-m", "add math"]);
  git(dir, ["switch", "--quiet", "-c", "feature"]);
  writeFileSync(join(dir, "math.ts"), "export const add = (left: number, right: number): number => left + right;\nexport const sub = (left: number, right: number): number => left - right;\n");
  git(dir, ["commit", "--quiet", "-am", "add sub"]);
  return dir;
}

async function judge(env: { readonly [name: string]: string }, options: Partial<RunOptions> = {}) {
  const cwd = repositoryWithChange();
  return runDiffRules({ cwd, env, mode: "full", fail: false, json: false, cacheDir: join(cwd, ".cache"), ...options });
}

const isRunning = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("diff-rules decision backend switch", () => {
  it("asks TypeSafe for every default rule when only TYPESAFE_API_KEY is set", async () => {
    const server = startMock();
    server.answerWith(0.8);
    const result = await judge({ TYPESAFE_API_KEY: "test-key", TYPESAFE_BASE_URL: server.origin });
    expect(server.requests).toEqual([{ path: "/v1/systemone", model: "jev-latest", bearer: true, questions: 4 }]);
    expect(result.report?.backend).toBe("decision-model");
    expect(result.report?.findings.map(({ id, fired }) => ({ id, fired }))).toEqual([
      { id: "shotgun-surgery", fired: true },
      { id: "divergent-change", fired: true },
      { id: "duplicated-code", fired: true },
      { id: "scope-creep", fired: true },
    ]);
    expect(result.exitCode).toBe(0);
  });

  it("asks OpenAI Decisions when ANTI_SLOP_DECISION_MODEL selects it", async () => {
    const server = startMock();
    server.answerWith(0.1);
    const result = await judge({
      ANTI_SLOP_DECISION_MODEL: "openai:gpt-6-luna",
      TYPESAFE_API_KEY: "test-key",
      OPENAI_API_KEY: "test-key",
      OPENAI_BASE_URL: `${server.origin}/v1`,
    });
    expect(server.requests).toEqual([{ path: "/v1/decisions", model: "gpt-6-luna", bearer: true, questions: 4 }]);
    expect(result.report?.models).toEqual(["gpt-6-luna-mock"]);
    expect(result.report?.findings.some(({ fired }) => fired)).toBe(false);
  });

  it("warns and skips when no decision credential or command is set, also under CI and --fail", async () => {
    const server = startMock();
    const result = await judge({ CI: "1" }, { fail: true });
    expect(server.requests).toEqual([]);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("no decision model credentials: TYPESAFE_API_KEY and OPENAI_API_KEY are both unset; skipping diff rules");
  });

  it("ends a judge command's whole pipeline when it times out", async () => {
    const dir = temporaryDirectory("fw-diff-rules-command-");
    const pidFile = join(dir, "holder.pid");
    // The left side of the pipeline is a grandchild that ending the shell alone leaves running.
    writeFileSync(join(dir, "holder.ts"), `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));\nsetTimeout(() => {}, 60_000);\n`);
    writeFileSync(join(dir, "config.json"), JSON.stringify({ timeoutMs: 1_500 }));
    const command = `"${process.execPath}" "${join(dir, "holder.ts")}" | "${process.execPath}" -e "process.stdin.resume()"`;
    const result = await judge({}, { backend: "command", command, configPath: join(dir, "config.json") });
    expect(result.report?.errors).toEqual(["command: judge command timed out after 1500ms"]);
    expect(isRunning(Number(readFileSync(pidFile, "utf8")))).toBe(false);
  });

  it("refuses a malformed ANTI_SLOP_DECISION_MODEL", async () => {
    const result = await judge({ ANTI_SLOP_DECISION_MODEL: "gpt-6-luna", OPENAI_API_KEY: "test-key" });
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('ANTI_SLOP_DECISION_MODEL must be typesafe:<model> or openai:<model>, not "gpt-6-luna"');
  });
});
