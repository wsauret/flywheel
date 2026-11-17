import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { runPrePush } from "../../../scripts/anti-slop-llm/pre-push.ts";
import { temporaryDirectories } from "../../helpers/directories.js";
import { startMockDecisionModels, type MockDecisionModels } from "../../helpers/mock-decision-models.js";

const prePushScript = resolve(import.meta.dir, "../../../scripts/anti-slop-llm/pre-push.ts");
const temporaryDirectory = temporaryDirectories();
const NO_COMMIT = "0".repeat(40);

// The developer's own keys, endpoints, and switches must not reach the checks.
const inheritedEnv = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => name !== "CI" && !/^(?:TYPESAFE_|OPENAI_|ANTI_SLOP_|JEV_)/.test(name)),
);

let mock: MockDecisionModels | undefined;
afterEach(() => {
  mock?.stop();
  mock = undefined;
});

function startMock(): MockDecisionModels {
  mock = startMockDecisionModels();
  return mock;
}

function git(cwd: string, args: readonly string[]): string {
  const result = Bun.spawnSync(["git", "-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
  });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
  return result.stdout.toString().trim();
}

interface Repository {
  readonly dir: string;
  /** `origin/main`: adds src/a.ts. */
  readonly main: string;
  /** Pushed before: changes src/a.ts. */
  readonly pushed: string;
  /** HEAD, not pushed yet: adds src/b.ts. */
  readonly head: string;
}

function repository(): Repository {
  const dir = temporaryDirectory("fw-pre-push-");
  const commit = (path: string, text: string, subject: string): string => {
    writeFileSync(join(dir, path), text);
    git(dir, ["add", "."]);
    git(dir, ["commit", "--quiet", "-m", subject]);
    return git(dir, ["rev-parse", "HEAD"]);
  };
  git(dir, ["init", "--quiet", "--initial-branch=main"]);
  mkdirSync(join(dir, "src"));
  const main = commit("src/a.ts", "export const one = 1;\n", "add a");
  git(dir, ["update-ref", "refs/remotes/origin/main", main]);
  git(dir, ["switch", "--quiet", "-c", "feature"]);
  const pushed = commit("src/a.ts", "export const one = 1;\nexport const two = 2;\n", "change a");
  const head = commit("src/b.ts", "export const three = 3;\n", "add b");
  return { dir, main, pushed, head };
}

const pushLine = (ref: string, local: string, remote: string): string => `${ref} ${local} ${ref} ${remote}\n`;

describe("anti-slop pre-push hook", () => {
  it("judges only the pushed commits of the checked-out branch, and skips deleted and other refs", async () => {
    const server = startMock();
    const repo = repository();
    const input = [
      pushLine("refs/heads/feature", repo.head, repo.pushed),
      pushLine("refs/heads/gone", NO_COMMIT, repo.main),
      pushLine("refs/heads/main", repo.main, NO_COMMIT),
    ].join("");
    const output = await runPrePush({ cwd: repo.dir, env: { ...inheritedEnv, TYPESAFE_API_KEY: "test-key", TYPESAFE_BASE_URL: server.origin }, input, timeoutMs: 60_000 });
    expect(output).toContain(`lint-changed: linting 1 file(s) changed against ${repo.pushed} (merge base ${repo.pushed.slice(0, 12)}).`);
    expect(output).toContain(`diff-rules: judged 1 changed file(s) in 1 request(s) against ${repo.pushed} (${repo.pushed.slice(0, 7)})`);
    expect(output).toContain("anti-slop pre-push: skipped refs/heads/main: it is not checked out");
    expect(output).not.toContain("refs/heads/gone");
  });

  it("judges a new branch against its merge base with origin/main", async () => {
    const server = startMock();
    const repo = repository();
    const input = pushLine("refs/heads/feature", repo.head, NO_COMMIT);
    const output = await runPrePush({ cwd: repo.dir, env: { ...inheritedEnv, TYPESAFE_API_KEY: "test-key", TYPESAFE_BASE_URL: server.origin }, input, timeoutMs: 60_000 });
    expect(output).toContain(`lint-changed: linting 2 file(s) changed against origin/main (merge base ${repo.main.slice(0, 12)}).`);
    expect(output).toContain(`diff-rules: judged 2 changed file(s) in 1 request(s) against origin/main (${repo.main.slice(0, 7)})`);
  });

  it("prints nothing, asks nothing, and exits 0 when no decision credential is set", async () => {
    const server = startMock();
    const repo = repository();
    const child = Bun.spawn([process.execPath, prePushScript], {
      cwd: repo.dir,
      env: inheritedEnv,
      stdin: new TextEncoder().encode(pushLine("refs/heads/feature", repo.head, repo.pushed)),
      stdout: "pipe",
      stderr: "pipe",
      windowsHide: true,
    });
    const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect({ stdout, stderr, exitCode }).toEqual({ stdout: "", stderr: "", exitCode: 0 });
    expect(server.requests).toEqual([]);
  });

  it("stops its checks at the time limit with a skipped line and leaves no check running", async () => {
    const server = startMock();
    server.delayAnswers(60_000);
    const repo = repository();
    const input = pushLine("refs/heads/feature", repo.head, repo.pushed);
    const started = performance.now();
    const output = await runPrePush({ cwd: repo.dir, env: { ...inheritedEnv, TYPESAFE_API_KEY: "test-key", TYPESAFE_BASE_URL: server.origin }, input, timeoutMs: 3_000 });
    expect(performance.now() - started).toBeLessThan(15_000);
    expect(output).toEndWith("anti-slop pre-push: skipped: timed out\n");
    expect(server.requests.length).toBeGreaterThan(0);
    // The checks' connections close only when their processes are gone.
    const deadline = Date.now() + 5_000;
    while (server.pending > 0 && Date.now() < deadline) await Bun.sleep(25);
    expect(server.pending).toBe(0);
  });
});
